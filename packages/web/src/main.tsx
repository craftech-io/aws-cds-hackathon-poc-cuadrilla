import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { BrandProvider } from "./context/BrandContext";
import { SessionProvider } from "./context/SessionContext";
import "./index.css";
import { RouterProvider } from "./lib/router";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <RouterProvider>
      <SessionProvider>
        <BrandProvider>
          <App />
        </BrandProvider>
      </SessionProvider>
    </RouterProvider>
  </StrictMode>,
);
