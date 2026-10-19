const demoPath = /^\/demonstracao(?:\/|$)/.test(window.location.pathname);
export const isOperational = import.meta.env.VITE_NEXO_MODE !== "demo" && !demoPath;
export const routerBasename = demoPath ? "/demonstracao" : undefined;
