import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './styles.css';
import { DialogHost } from './ui';

// tema: o escolhido pelo usuário; sem escolha, o do sistema
document.documentElement.dataset.theme = localStorage.getItem('nexo_theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <DialogHost />
    </BrowserRouter>
  </React.StrictMode>,
);
