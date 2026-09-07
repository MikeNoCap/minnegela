import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@minnegela/shared'],
  headers: async () => [{ source: '/(.*)', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] }],
};
export default nextConfig;
