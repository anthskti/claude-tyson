import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The fight scene, coach, and contracts live beside app/, not inside it.
  serverExternalPackages: [],
};

export default nextConfig;
