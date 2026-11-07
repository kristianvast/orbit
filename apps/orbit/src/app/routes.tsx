import { Route, Routes } from "react-router";
import CamerasPage from "../features/cameras";
import ChatPage from "../features/chat";
import DevicesPage from "../features/devices";
import HerdPage from "../features/herd";
import CustomPageView from "../features/pages";
import SettingsPage from "../features/settings";
import { HomePage } from "./HomePage";
import { AppShell } from "./shell";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="herd" element={<HerdPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="cameras" element={<CamerasPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="pages/:id" element={<CustomPageView />} />
      </Route>
    </Routes>
  );
}
