import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import CitationImpact from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CitationImpact />
  </StrictMode>,
)
