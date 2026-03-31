/** @type {import('@rspack/cli').Configuration} */
export default {
    devtool: false,
    entry: {
        main: "./src/index.ts",
    },
    externals: {
        "@chili3d/core": "Chili3dCore",
        "@chili3d/element": "Chili3dElement",
    },
    externalsType: "assign",
    experiments: {
        css: true,
        outputModule: true,
    },
    module: {
        parser: {
            "css/auto": {
                namedExports: false,
            },
        },
        rules: [
            {
                test: /\.glb$/,
                type: "asset",
            },
            {
                test: /\.svg$/,
                type: "asset",
            },
            {
                test: /\.(j|t)s$/,
                loader: "builtin:swc-loader",
                options: {
                    jsc: {
                        parser: {
                            syntax: "typescript",
                            decorators: true,
                        },
                        target: "esnext",
                    },
                },
            },
        ],
    },
    resolve: {
        extensions: [".ts", ".js", ".json"],
    },
    optimization: {
        concatenateModules: true,
        avoidEntryIife: true,
        splitChunks: false,
        minimize: true,
    },
    output: {
        clean: true,
        filename: "extension.js",
        module: true,
        chunkFormat: "module",
        library: {
            type: "modern-module",
        },
        chunkLoading: "import",
        workerChunkLoading: "import",
    },
};
