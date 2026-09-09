import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@minnegela/shared'],
  headers: async () => [{ source: '/(.*)', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] }],
};
export default withNextIntl(nextConfig);
