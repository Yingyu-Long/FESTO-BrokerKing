import { useEffect, useRef, useState } from "react";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import Dashboard from "./app/dashboard/Dashboard";
import { useDevice } from "./app/dashboard/useDevice";
import { connectionLabel, connectionNotice } from "./app/connectionStatus";
import Config from "./app/config/Config";
import Modbus from "./app/Modbus/Modbus";
import MqttOutput from "./app/mqtt/MqttOutput";
import Icon from "./app/components/Icon";
import { translations, type Language } from "./translate";

function C2MInner({
  language,
  externalRoute,
  onRouteChange,
}: {
  language: Language;
  externalRoute?: { path: string; seq: number };
  onRouteChange?: (path: string) => void;
}) {
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }

  const copy = translations[language];
  const device = useDevice(notify, language);
  const params = device.params;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const statusLabel = connectionLabel(device.backend, language === "zh");
  const isOnline = device.backend?.status === "connected" && device.backend?.fresh;

  useEffect(() => {
    onRouteChange?.(pathname);
  }, [pathname, onRouteChange]);

  useEffect(() => {
    if (externalRoute && externalRoute.seq > 0 && externalRoute.path !== pathname) {
      navigate(externalRoute.path);
    }
  }, [externalRoute]);

  return (
    <div className="c2m-scope">
      <div className="unified-module-container">
        <div className="unified-module-header">
          <div className="unified-module-title-group">
            <h1>
              MSE6-C2M <span>{copy.app.module}</span>
            </h1>
          </div>
          <div className="unified-module-controls">
            <span className={`unified-status-pill ${isOnline ? "is-connected" : ""}`}>
              <i />
              {statusLabel}
            </span>
          </div>
        </div>

        {(!device.dataReady || device.apiError || device.backend?.warnings.length) && (
          <div className="device-notice" role="status">
            {device.apiError ||
              connectionNotice(device.backend, device.dataReady, language === "zh")}
          </div>
        )}
        <Routes>
          <Route
            path="/overview"
            element={
              <Dashboard
                params={params}
                device={device}
                onOpenConfig={() => navigate("/parameters")}
                notify={notify}
                language={language}
              />
            }
          />
          <Route
            path="/parameters"
            element={
              <Config
                key={device.settingsScope}
                device={device}
                notify={notify}
                language={language}
              />
            }
          />
          <Route
            path="/connection"
            element={<Modbus notify={notify} language={language} device={device} />}
          />
          <Route
            path="/mqtt"
            element={<MqttOutput language={language} device={device} notify={notify} />}
          />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}

export default function C2MModule({
  language,
  externalRoute,
  onRouteChange,
}: {
  language: Language;
  externalRoute?: { path: string; seq: number };
  onRouteChange?: (path: string) => void;
}) {
  return (
    <MemoryRouter initialEntries={["/overview"]}>
      <C2MInner language={language} externalRoute={externalRoute} onRouteChange={onRouteChange} />
    </MemoryRouter>
  );
}
