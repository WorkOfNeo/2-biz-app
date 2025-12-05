/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  webpack: (config, { isServer }) => {
    // Exclude playwright-core from webpack bundling for server-side code
    if (isServer) {
      config.externals = [...(config.externals || []), 'playwright-core'];
    }
    return config;
  }
};

export default nextConfig;

