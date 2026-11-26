import { useRef, useState } from "react";
import type { Parameters, Snapshot } from "../types";
import type { DeviceController } from "./useDevice";
import OperationControl from "./OperationControl";
import TrendChart from "./TrendChart";
import ConsumptionResetDialog from "./ConsumptionResetDialog";
import { fields } from "../config/fields";
import Icon from "../components/Icon";
import Panel from "../components/Panel";
import { translations, type Language } from "../../translate";

type DashboardProps = {
  params: Parameters;
  device: DeviceController;
  onOpenConfig: () => void;
  notify: (message: string) => void;
  language: Language;
};

export default function Dashboard({
  params,
  device,
  onOpenConfig,
  notify,
  language,
}: DashboardProps) {
  const { mode, samples } = device;
  const current: Snapshot = samples[samples.length - 1] ?? {
    flow: 0,
    pressure: 0,
    consumption: 0,
    delta: 0,
    tick: 0,
    phase: "UNKNOWN",
  };
  const copy = translations[language].dashboard;
  const [resetOpen, setResetOpen] = useState(false);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const valveOpen = device.valveOpen;
  const standbyHeld = device.backend?.controls?.standbyHeld ?? false;
  const leakEligible = device.dataReady && device.deltaReady && !valveOpen && mode === "user";
  const leak = leakEligible && -current.delta > params.leakLimit;
  const closeReset = () => {
    setResetOpen(false);
    resetTrigger.current?.focus();
  };
  return (
    <>
      <div className="metrics">
        {[
          {
            label: copy.currentFlow,
            value: current.flow.toFixed(1),
            unit: "l/min",
            icon: "flow",
            detail: !device.backend?.parameters
              ? "—"
              : `${copy.lowFlowThreshold} ${params.threshold} l/min`,
          },
          {
            label: copy.outputPressure,
            value: current.pressure.toFixed(2),
            unit: "bar",
            icon: "pressure",
            detail: !device.backend?.parameters
              ? "—"
              : `${copy.targetPressure} ${mode === "user" ? params.userPressure : standbyHeld || ["SHUTOFF", "STANDBY"].includes(current.phase) ? params.standby : params.normal} bar`,
          },
          {
            label: copy.totalConsumption,
            value: current.consumption.toFixed(3),
            unit: "m³",
            icon: "total",
            detail: copy.sessionTotal,
          },
          {
            label: copy.pressureChange,
            value: `${current.delta > 0 ? "+" : ""}${current.delta.toFixed(2)}`,
            unit: "bar/s",
            icon: "trend",
            detail: leak
              ? copy.leakWarning
              : leakEligible
                ? copy.leakMonitoring
                : copy.leakAssessment,
          },
        ].map((m) => (
          <section className="metric-card" key={m.label}>
            <div className="metric-label">
              <span>{m.label}</span>
              <Icon name={m.icon} />
            </div>
            <div className="metric-value">
              {device.dataReady && (m.icon !== "trend" || device.deltaReady) ? m.value : "—"}
              <span>{m.unit}</span>
            </div>
            <div className="metric-bottom">
              <span>{device.dataReady ? m.detail : "—"}</span>
            </div>
          </section>
        ))}
      </div>
      <div className="primary-grid">
        <OperationControl
          params={params}
          device={device}
          phase={current.phase}
          notify={notify}
          language={language}
        />
        <TrendChart
          samples={samples}
          threshold={params.threshold}
          parametersReady={!!device.backend?.parameters}
          dataReady={device.dataReady}
          language={language}
        />
      </div>
      <div className="secondary-grid">
        <Panel
          title={copy.automaticParameters}
          extra={
            <button className="text-button" onClick={() => onOpenConfig()}>
              <Icon name="settings" size={16} />
              {copy.editParameters}
            </button>
          }
        >
          <div className="parameter-summary">
            {fields.slice(0, 4).map((f) => (
              <div key={f.key}>
                <span>{language === "en" ? f.titleEn : f.title}</span>
                <strong>
                  {device.backend?.parameters ? params[f.key] : "—"} <small>{f.unit}</small>
                </strong>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title={copy.consumptionManagement}>
          <div className="consumption-body">
            <div>
              <span>{copy.consumptionCost}</span>
              <strong>
                {device.dataReady ? `¥ ${(current.consumption * params.price).toFixed(2)}` : "—"}
              </strong>
              <small>
                {copy.estimatedAt} ¥ {params.price.toFixed(2)} / m³
              </small>
            </div>
            <button
              ref={resetTrigger}
              className="button"
              disabled={!device.canControl}
              onClick={() => setResetOpen(true)}
            >
              <Icon name="reset" size={16} />
              {copy.resetConsumption}
            </button>
          </div>
        </Panel>
      </div>
      {resetOpen && (
        <ConsumptionResetDialog
          consumption={current.consumption}
          canControl={device.canControl}
          resetConsumption={device.resetConsumption}
          onClose={closeReset}
          notify={notify}
          language={language}
        />
      )}
    </>
  );
}
