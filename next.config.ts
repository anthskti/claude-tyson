import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The fight scene and contracts live outside the Next.js app directory.
  serverExternalPackages: [],
  // CV runtime and models (scripts/cv-assets.ts): versioned paths, so cache for good.
  async headers() {
    return [{ source: '/cv/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }];
  },
};

export default nextConfig;
