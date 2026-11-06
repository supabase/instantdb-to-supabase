import type { Metadata } from 'next'

import { basePath } from '../../../src/base-path'
import { ImportPage } from '../../../src/client/import-page'
import { siteDescription, siteTitle } from '../../../src/site-metadata'

const socialImage = {
  url: 'https://supabase.com/images/og/supabase-og.png',
  width: 1200,
  height: 600,
  alt: 'Supabase',
}

export const metadata: Metadata = {
  alternates: { canonical: basePath },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: basePath,
    siteName: 'Supabase',
    type: 'website',
    images: [socialImage],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@supabase',
    title: siteTitle,
    description: siteDescription,
    images: [socialImage],
  },
}

export default function Page() {
  return <ImportPage />
}
