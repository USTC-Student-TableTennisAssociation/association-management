import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 资料库对象是运行时数据，不应被打包进 Next 服务器产物。
  outputFileTracingExcludes: {
    "/*": ["./.echo-library/**/*"],
  },
};

export default nextConfig;
