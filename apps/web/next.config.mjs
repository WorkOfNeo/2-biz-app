/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  serverExternalPackages: ['playwright-core']
};

export default nextConfig;

