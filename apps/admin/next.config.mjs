/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker image (infrastructure/docker/web.Dockerfile) copies
  // .next/standalone into the runtime stage; without this the build has no
  // standalone output and the image build fails.
  output: 'standalone',
  transpilePackages: ['@stellar-pay/sdk', '@stellar-pay/types', '@stellar-pay/ui'],
};

export default nextConfig;
