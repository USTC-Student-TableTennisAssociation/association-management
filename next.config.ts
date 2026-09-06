import type { NextConfig } from "next";

const configuredDistDirectory = process.env.SYDARIS_NEXT_DIST_DIR?.trim();
if (configuredDistDirectory && !/^\.next-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(configuredDistDirectory)) {
  throw new Error("SYDARIS_NEXT_DIST_DIR 必须是项目内的 .next-<name> 目录");
}

const nextConfig: NextConfig = {
  ...(configuredDistDirectory ? { distDir: configuredDistDirectory } : {}),
  // 资料库对象是运行时数据，不应被打包进 Next 服务器产物。
  outputFileTracingExcludes: {
    "/*": ["./.sydaris-library/**/*", "./.cold-start/**/*", "./.sydaris-instances/**/*"],
  },
};

export default nextConfig;
