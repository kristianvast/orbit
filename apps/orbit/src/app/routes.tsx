import { Camera, MessageSquare, Plus, Radio, Tag } from "lucide-react";
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
import { HomePage } from "./HomePage";
import { AppShell } from "./shell";

const MODULE_META: Record<
  ModuleId,
  {
    titleKey: MessageKey;
    descKey: MessageKey;
    promptKey: MessageKey;
    icon: typeof Tag;
  }
> = {
  herd: {
    titleKey: "shell.module.disabled.herd.title",
    descKey: "shell.module.disabled.herd.description",
    promptKey: "shell.module.disabled.herd.prompt",
    icon: Tag,
  },
  devices: {
    titleKey: "shell.module.disabled.devices.title",
    descKey: "shell.module.disabled.devices.description",
    promptKey: "shell.module.disabled.devices.prompt",
    icon: Radio,
  },
  cameras: {
    titleKey: "shell.module.disabled.cameras.title",
    descKey: "shell.module.disabled.cameras.description",
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
  const prompt = t(meta.promptKey);

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
        title={t(meta.titleKey)}
        description={t(meta.descKey)}
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
            <Button
              variant="secondary"
              loading={enabling}
              icon={<Plus size={16} />}
              onClick={() => void handleEnableNow()}
              data-testid={`module-disabled-enable-${moduleId}`}
            >
              {t("shell.module.disabled.addNow")}
            </Button>
          </div>
        }
      />
    </div>
  );
}

export function AppRoutes() {
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
        <Route path="pages/:id" element={<CustomPageView />} />
      </Route>
    </Routes>
  );
}
