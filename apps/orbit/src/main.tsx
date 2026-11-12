import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./design/tokens.css";
import { AppProviders, AppRoutes, readThemePreference, systemTheme } from "./app";
import { captureLocalUiReturn, handOffToLocalUi, localUiBasename } from "./lib/local-ui";

// Paint the right theme before React mounts, so a dark OS never flashes light.
const savedPreference = readThemePreference();
const initialTheme =
  savedPreference === "light" || savedPreference === "dark" ? savedPreference : systemTheme();
if (initialTheme) document.documentElement.setAttribute("data-theme", initialTheme);

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
