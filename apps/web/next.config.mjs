// A blank value (a Vercel/env variable defined but empty) means "not
// configured": falling through keeps the rewrite destination absolute, which
// Next requires — `${''}/api/:path*` is rejected as a relative destination.
const API_URL = process.env.NEXT_PUBLIC_API_URL?.trim() || 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker image (infrastructure/docker/web.Dockerfile) copies
  // .next/standalone into the runtime stage; without this the build has no
  // standalone output and the image build fails.
  output: 'standalone',
  transpilePackages: [
    '@stellar-pay/sdk',
    '@stellar-pay/shared',
    '@stellar-pay/types',
    '@stellar-pay/ui',
    '@stellar-pay/wallet',
  ],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  // Proxy API calls in development to avoid CORS issues and network errors
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/api/:path*`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${API_URL}/socket.io/:path*`,
      },
    ];
  },
};

export default nextConfig;
