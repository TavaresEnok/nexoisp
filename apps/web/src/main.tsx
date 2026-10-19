import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./globals.css";
import "./fonts.css";
import { App } from "./app";
import { routerBasename } from "@/platform/execution";
import "./erp.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter basename={routerBasename}><App /></BrowserRouter></StrictMode>,
);
