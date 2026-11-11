import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./design/tokens.css";
import { AppProviders, AppRoutes } from "./app";
import { captureLocalUiReturn, handOffToLocalUi, localUiBasename } from "./lib/local-ui";

try {
  const savedTheme = window.localStorage?.getItem("orbit.theme");
  if (savedTheme === "dark" || savedTheme === "light") {
    document.documentElement.setAttribute("data-theme", savedTheme);
  }
} catch {}

captureLocalUiReturn();
void handOffToLocalUi();

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter basename={localUiBasename()}>
        <AppProviders>
          <AppRoutes />
        </AppProviders>
      </BrowserRouter>
    </StrictMode>,
  );
}
