import type { FluxFetchApi } from './index'

declare global {
  interface Window {
    fluxfetch: FluxFetchApi
  }
}
