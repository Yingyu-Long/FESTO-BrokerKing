import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import Dashboard from "./app/Dashboard/dashboard";
import Add from "./app/Add/Add";
import Siemens from "./app/Add/Siemens";
import Rockwell from "./app/Add/Rockwell";
import Opcua from "./app/Add/Opcua";
import Beckhoff from "./app/Add/Beckhoff";
import Modbus from "./app/Add/Modbus";
import Mqtt from "./app/Add/Mqtt";
import {
  ConnectorLanguageContext,
  ConnectorRouteSync,
  type ConnectorLanguage,
} from "./app/AppLayout";

export default function ConnectorModule({
  language,
  externalRoute,
  onRouteChange,
}: {
  language: ConnectorLanguage;
  externalRoute?: { path: string; seq: number };
  onRouteChange?: (path: string) => void;
}) {
  return (
    <ConnectorLanguageContext.Provider value={language}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ConnectorRouteSync externalRoute={externalRoute} onRouteChange={onRouteChange} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/status" element={<Dashboard />} />
          <Route path="/import" element={<Dashboard />} />
          <Route path="/downloads" element={<Dashboard />} />
          <Route path="/add" element={<Add />} />
          <Route path="/add/siemens" element={<Siemens />} />
          <Route path="/add/rockwell" element={<Rockwell />} />
          <Route path="/add/opcua" element={<Opcua />} />
          <Route path="/add/beckhoff" element={<Beckhoff />} />
          <Route path="/add/modbus" element={<Modbus />} />
          <Route path="/add/modbus-customised" element={<Modbus />} />
          <Route path="/mqtt" element={<Mqtt />} />
          <Route path="/siemens" element={<Siemens />} />
          <Route path="/rockwell" element={<Rockwell />} />
          <Route path="/opcua" element={<Opcua />} />
          <Route path="/beckhoff" element={<Beckhoff />} />
          <Route path="/modbus" element={<Modbus />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </MemoryRouter>
    </ConnectorLanguageContext.Provider>
  );
}
