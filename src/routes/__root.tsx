import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import indexCss from '../index.css?url'

const queryClient = new QueryClient()

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    links: [{ rel: 'stylesheet', href: indexCss }],
    scripts: [
      {
        children: `(function(){try{var r=document.documentElement;var f=localStorage.getItem('simple-theme-family')||'sand';var t=localStorage.getItem('simple-text-style')||'system';var m=localStorage.getItem('simple-theme-mode')||'';var d=m==='system'?window.matchMedia('(prefers-color-scheme: dark)').matches:localStorage.getItem('simple-dark-mode')==='true';r.dataset.themeFamily=f;r.dataset.textStyle=t;if(d)r.classList.add('dark')}catch(e){}})()`,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
