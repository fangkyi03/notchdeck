import { createRoot } from "react-dom/client";
import { api } from "../lib/api";
import { applySkin } from "../lib/themes";
import { DataProvider } from "./data";
import { Island } from "./Island";
import "./island.css";

api.getConfig().then((cfg) => {
  applySkin(cfg);
  createRoot(document.getElementById("root")!).render(
    <DataProvider initial={cfg}>
      <Island />
    </DataProvider>,
  );
});
