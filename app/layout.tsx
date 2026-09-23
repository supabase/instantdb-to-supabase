import './globals.css'

import localFont from 'next/font/local'
import type { ReactNode } from 'react'

import { Telemetry } from '../src/telemetry/client'
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

export const metadata = {
  title: 'InstantDB to Supabase Migration',
  description:
    'Migrate your InstantDB backup to Supabase with Postgres tables, Auth accounts, Storage files, and readable SQL migrations.',
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
          <Telemetry />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
