
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import Dashboard from './pages/Dashboard'
import Indicator from './pages/Indicator'
import About from './pages/About'
import ReviewPopup from './pages/ReviewPopup'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/indicator" element={<Indicator />} />
        <Route path="/about" element={<About />} />
        <Route path="/review-popup" element={<ReviewPopup />} />
      </Routes>
    </HashRouter>
  </StrictMode>,
)
