import { Camera, MessageSquare, Plug, Plus, Tag } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { Button, EmptyState, Skeleton } from "../design";
import CamerasPage from "../features/cameras";
import ChatPage from "../features/chat";
import DevicesPage from "../features/devices";
import HerdPage from "../features/herd";
import CustomPageView from "../features/pages";
import SettingsPage from "../features/settings";
import { type MessageKey, useT } from "../i18n";
import { type ModuleId, useModules } from "../lib/modules";
import { useFarmSpecies } from "../lib/species";
import { HomePage } from "./HomePage";
import { useTheme } from "./providers";
import { AppShell } from "./shell";

const MODULE_META: Record<
  ModuleId,
  {
    titleKey: MessageKey;
    promptKey: MessageKey;
    icon: typeof Tag;
  }
> = {
  herd: {
    titleKey: "shell.module.disabled.herd.title",
    promptKey: "shell.module.disabled.herd.prompt",
    icon: Tag,
  },
  devices: {
    titleKey: "shell.module.disabled.devices.title",
    promptKey: "shell.module.disabled.devices.prompt",
    icon: Plug,
  },
  cameras: {
    titleKey: "shell.module.disabled.cameras.title",
    promptKey: "shell.module.disabled.cameras.prompt",
    icon: Camera,
  },
};

export interface ModuleRouteProps {
  moduleId: ModuleId;
  children: ReactNode;
}

export function ModuleRoute({ moduleId, children }: ModuleRouteProps) {
  const { loading, isEnabled, enableModule } = useModules();
  const { species } = useFarmSpecies();
  const navigate = useNavigate();
  const t = useT();
  const [enabling, setEnabling] = useState(false);

  if (loading) {
    return (
      <div className="orbit-container" data-testid={`module-loading-${moduleId}`}>
        <Skeleton height="2.5rem" width="16rem" />
        <Skeleton height="12rem" />
      </div>
    );
  }

  if (isEnabled(moduleId)) {
    return <>{children}</>;
  }

  const meta = MODULE_META[moduleId];
  const Icon = meta.icon;
  const titleKey: MessageKey =
    moduleId === "herd"
      ? species === "horse"
        ? "shell.module.disabled.herd.title.horse"
        : "shell.module.disabled.herd.title.cattle"
      : meta.titleKey;
  const promptKey: MessageKey =
    moduleId === "herd"
      ? species === "horse"
        ? "shell.module.disabled.herd.prompt.horse"
        : "shell.module.disabled.herd.prompt.cattle"
      : moduleId === "devices" && species === "horse"
        ? "shell.module.disabled.devices.prompt.horse"
        : meta.promptKey;
  const prompt = t(promptKey);

  const handleAskOrion = () => {
    navigate(`/chat?prompt=${encodeURIComponent(prompt)}&send=1`, {
      state: { prefill: prompt },
    });
  };

  const handleEnableNow = async () => {
    setEnabling(true);
    try {
      await enableModule(moduleId);
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="orbit-container" data-testid={`module-disabled-${moduleId}`}>
      <EmptyState
        icon={<Icon size={24} />}
        title={t(titleKey)}
        action={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexWrap: "wrap",
              gap: "var(--space-3)",
            }}
          >
            <Button
              variant="primary"
              icon={<MessageSquare size={16} />}
              onClick={handleAskOrion}
              data-testid={`module-disabled-ask-${moduleId}`}
            >
              {t("shell.module.disabled.askOrion")}
            </Button>
            {moduleId !== "devices" && (
              <Button
                variant="secondary"
                loading={enabling}
                icon={<Plus size={16} />}
                onClick={() => void handleEnableNow()}
                data-testid={`module-disabled-enable-${moduleId}`}
              >
                {t("shell.module.disabled.addNow")}
              </Button>
            )}
          </div>
        }
      />
    </div>
  );
}

export function AppRoutes() {
  const { theme } = useTheme();
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route
          path="herd"
          element={
            <ModuleRoute moduleId="herd">
              <HerdPage />
            </ModuleRoute>
          }
        />
        <Route
          path="devices"
          element={
            <ModuleRoute moduleId="devices">
              <DevicesPage />
            </ModuleRoute>
          }
        />
        <Route
          path="cameras"
          element={
            <ModuleRoute moduleId="cameras">
              <CamerasPage />
            </ModuleRoute>
          }
        />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="pages/:id" element={<CustomPageView theme={theme} />} />
      </Route>
    </Routes>
  );
}
