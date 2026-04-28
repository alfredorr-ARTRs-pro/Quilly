import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 9500,
    strictPort: true, // Fail if port is already in use
  },
  base: './', // Relative paths for Electron file loading
})
