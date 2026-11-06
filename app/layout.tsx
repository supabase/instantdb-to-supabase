import './globals.css'

import type { Metadata } from 'next'
import localFont from 'next/font/local'
import type { ReactNode } from 'react'

import { siteDescription, siteTitle } from '../src/site-metadata'
import { Telemetry } from '../src/telemetry/client'
import { telemetryConfig } from '../src/telemetry/server'
import { ThemeProvider } from '../vendor/common/Providers'

const inter = localFont({
  src: '../public/fonts/InterVariable.woff2',
  display: 'swap',
  variable: '--font-inter',
  weight: '100 900',
})
const mono = localFont({
  src: '../public/fonts/SourceCodePro-Variable.woff2',
  display: 'swap',
  variable: '--font-source-code-pro',
  weight: '200 900',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://supabase.com'),
  title: siteTitle,
  description: siteDescription,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body>
        <ThemeProvider
          attribute="class"
          themes={['light', 'dark']}
          storageKey="instant-import-theme"
        >
          <Telemetry apiKey={telemetryConfig()?.key ?? null} />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
