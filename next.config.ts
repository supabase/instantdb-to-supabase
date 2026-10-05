import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'

import { basePath } from './src/base-path'

// The SDK otherwise puts local history under .next, which builds can clear.
if (!process.env.VERCEL_DEPLOYMENT_ID && !process.env.WORKFLOW_TARGET_WORLD) {
  process.env.WORKFLOW_TARGET_WORLD = 'local'
  process.env.WORKFLOW_LOCAL_DATA_DIR ??= '.workflow-data'
}

const nextConfig: NextConfig = {
  basePath,
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  agentRules: false,
  transpilePackages: ['ui', 'ui-patterns'],
  async redirects() {
    return [
      {
        source: '/',
        // supabase.com proxies only the basePath, so sending the bare deployment root there cannot loop.
        destination:
          process.env.VERCEL_ENV === 'production' ? `https://supabase.com${basePath}` : basePath,
        basePath: false,
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
