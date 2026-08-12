import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@/index.css";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>
);
