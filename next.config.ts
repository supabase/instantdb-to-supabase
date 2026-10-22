import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'

import { basePath } from './src/base-path'

// The SDK otherwise puts local history under .next, which builds can clear.
if (!process.env.VERCEL_DEPLOYMENT_ID && !process.env.WORKFLOW_TARGET_WORLD) {
  process.env.WORKFLOW_TARGET_WORLD = 'local'
  process.env.WORKFLOW_LOCAL_DATA_DIR ??= '.workflow-data'
}

const nextConfig: NextConfig = {
  // Routes live under app/migrate/instantdb instead of Next's basePath: on Vercel, queue-triggered
  // Workflow routes 404 under a basePath (vercel/workflow#4971), so they must stay at the root.
  assetPrefix: basePath,
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  agentRules: false,
  transpilePackages: ['ui', 'ui-patterns'],
  async rewrites() {
    return [{ source: `${basePath}/_next/:path*`, destination: '/_next/:path*' }]
  },
  async redirects() {
    return [
      {
        source: '/',
        // supabase.com proxies only the basePath, so sending the bare deployment root there cannot loop.
        destination:
          process.env.VERCEL_ENV === 'production' ? `https://supabase.com${basePath}` : basePath,
        permanent: false,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}
export default withWorkflow(nextConfig)
