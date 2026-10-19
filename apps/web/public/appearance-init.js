(() => {
  const appearance = document.cookie.match(/(?:^|;\s*)nexo-appearance=(dark|light)(?:;|$)/)?.[1];
  document.documentElement.classList.toggle('dark', appearance ? appearance === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
})();
