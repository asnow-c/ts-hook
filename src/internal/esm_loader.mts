import * as Path from "node:path";
import Module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import { ModResolveError, Pkg, requestToNameAndSubPath } from "./common_loader.mjs";
import { toAbsPath } from "../util/file_tool.mjs";
export const ExtraModule = Module as ExtraModule;

//cjs和mjs扩展名规则
export async function tryWithoutExt(absRequest: string): Promise<ResolveFxReturn | undefined> {
    let { ext } = Path.parse(absRequest);
    let absPathWithoutExt = ext === "" ? absRequest : absRequest.slice(0, -ext.length);

    let fileUrl: string | undefined;
    let format: PkgFormat;
    if (ext === ".mjs") {
        fileUrl = await tryFile(absPathWithoutExt, [".mts"]);
        format = "module";
    } else if (ext === ".cjs") {
        fileUrl = await tryFile(absPathWithoutExt, [".cts"]);
        format = "commonjs";
    } else if (ext === ".js") {
        fileUrl = await tryFile(absPathWithoutExt, [".ts"]);
        if (fileUrl) {
            format = ExtraModule._readPackage(fileURLToPath(fileUrl))?.type === "module" ? "module" : "commonjs";
        }
    }
    if (fileUrl) return { url: fileUrl, format: format!, shortCircuit: true };
}

export async function tryFile(absPathWithoutExt: string, extList: string[]): Promise<string | undefined> {
    let tryDir: string[] = [];
    for (const ext of extList) {
        let absPath = absPathWithoutExt + ext;
        let info: Stats;
        try {
            info = await fsp.stat(absPath);
        } catch (error) {
            continue;
        }
        if (info.isFile()) return pathToFileURL(absPath).toString();
        else if (info.isDirectory()) tryDir.push(absPath);
    }
    for (const dir of tryDir) {
        let fileUrl = await tryPkg(dir);
        if (fileUrl) return fileUrl;
    }
}
async function tryDirMod(path: string) {
    let modPath = await tryFile(Path.resolve(path, "index"), [".js", ".ts"]);
    if (modPath) return modPath;
}
export async function tryPkg(path: string): Promise<string | undefined> {
    const main = ExtraModule._readPackage(path)?.main;
    if (main) return tryFile(Path.resolve(path, main), [".ts"]);
    else return tryDirMod(path);
}

export async function tryTs(resolvedPath: string) {
    let result = await tryWithoutExt(resolvedPath);
    if (result) return result;

    let filename = await tryFile(resolvedPath, ["", ".ts"]);
    if (!filename) return;

    let format: PkgFormat =
        ExtraModule._readPackage(fileURLToPath(filename!))?.type === "module" ? "module" : "commonjs";
    return {
        url: filename!,
        format,
        shortCircuit: true,
    };
}

export async function tryTsAlias(request: string, parentFilename: string): Promise<ResolveFxReturn | undefined> {
    const pkg = Pkg.upSearchPkg(Path.resolve(parentFilename, ".."));
    if (!pkg) return;
    let filename = await pkg.tryTsAlias(parentFilename, request);
    if (filename) return { url: fileURLToPath(filename), shortCircuit: true, format: pkg.getFileFormat(filename) };
}

export async function resolveEntryFile(urlString: string): Promise<ResolveFxReturn | undefined> {
    //入口文件
    let format = await getTsModule(fileURLToPath(urlString)); //format为undefined时说明入口文件不是ts文件
    if (format) {
        return {
            format,
            url: urlString,
            shortCircuit: true,
        };
    }
}
async function getTsModule(filename: string): Promise<PkgFormat | undefined> {
    let ext = filename.match(/\.[cm]?ts$/)?.[0];
    if (ext) {
        if (ext === ".mts") return "module";
        else if (ext === ".cts") return "commonjs";
        else {
            let fileDir = Path.resolve(filename, "..");
            const pkg = Pkg.upSearchPkg(fileDir);
            if (pkg) return pkg.defaultFormat;
            else return "commonjs";
        }
    }
}

type ForwardResult = ResolveFxReturn | undefined;
export class EsmErrorHandler {
    async forwardError(error: ModResolveError, specifier: string, parentUrl: string): Promise<ForwardResult> {
        switch (error.code) {
            case "ERR_MODULE_NOT_FOUND":
                let pkgPath = /^Cannot find package '([^']*)' imported from /.exec(error.message)?.[1];

                if (pkgPath) {
                    let result = this.handlerPkgNotFound(pkgPath, specifier);
                    if (result) return result;
                } else {
                    let resolvedPath = /^Cannot find module '([^']*)' imported from /.exec(error.message)?.[1];
                    if (!resolvedPath) throw error;
                    let result = await this.handlerModuleNotFind(resolvedPath, specifier, parentUrl);
                    if (result) return result;
                }

                break;
            default:
                return this.handlerOtherErr(error, specifier, parentUrl);
        }
    }
    async handlerOtherErr(error: ModResolveError, specifier: string, parentUrl: string): Promise<ForwardResult> {
        return;
    }
    async handlerPkgNotFound(pkgPath: string, specifier: string): Promise<ForwardResult> {
        if (pkgPath === specifier) return;
        else {
            const pkgName = requestToNameAndSubPath(specifier)?.pkgName;
            if (pkgName === specifier)
                //只导入包名且 导入的包没有 main 和 exports 字段
                return this.pkgNotFound_mainHandler(pkgPath, specifier);
        }
    }
    async pkgNotFound_mainHandler(pkgPath: string, specifier: string): Promise<ForwardResult> {
        //只导入包名且 导入的包没有 main 和 exports 字段
        let main = Pkg.getPkg(pkgPath)?.main;
        if (!main) return;
        return tryWithoutExt(Path.resolve(pkgPath, main));
    }
    async handlerModuleNotFind(resolvedPath: string, specifier: string, parentUrl: string) {
        return tryWithoutExt(resolvedPath);
    }
}
export class CommonAdapter extends EsmErrorHandler {
    async handlerModuleNotFind(resolvedPath: string, specifier: string, parentUrl: string) {
        let isSubMod;
        if (Path.sep === "\\") isSubMod = resolvedPath.replaceAll("\\", "/").endsWith(specifier);
        else isSubMod = resolvedPath.endsWith(specifier);

        if (isSubMod) {
            //导入没有exports字段的包的子模块
            const pkgName = requestToNameAndSubPath(specifier)!.pkgName;
            const pkgPath = resolvedPath.slice(0, -specifier.length) + Path.sep + pkgName;
            const pkg = Pkg.getPkg(pkgPath);
            if (!pkg) return;
            resolvedPath = Path.resolve(pkg.pkgPath, "..", specifier);
            return tryTs(resolvedPath);
        } else {
            //相对路径导入文件或文件夹
            const parentDir = Path.resolve(fileURLToPath(parentUrl), "..");
            let absRequestPath = toAbsPath(specifier, parentDir);
            if (absRequestPath) return tryTs(absRequestPath);
            else return super.handlerModuleNotFind(resolvedPath, specifier, parentUrl);
        }
    }
    async pkgNotFound_mainHandler(pkgPath: string, specifier: string) {
        //main 和 默认 index
        let main = Pkg.getPkg(pkgPath)?.main ?? "index.js";
        if (!main) return;
        return tryWithoutExt(Path.resolve(pkgPath, main));
    }
    async handlerUnsupportedDirImport(message: string): Promise<ForwardResult> {
        //导入的包的子模块为目录
        const matchRegExp = /^Directory import '([^']*)' is not supported resolving ES modules imported from /;
        const resolvedPath = matchRegExp.exec(message)?.[1];

        if (!resolvedPath) return;
        return tryTs(resolvedPath);
    }
    async handlerOtherErr(error: ModResolveError, specifier: string, parentUrl: string) {
        if (error.code === "ERR_UNSUPPORTED_DIR_IMPORT") {
            return this.handlerUnsupportedDirImport(error.message);
        }
        return;
    }
}
