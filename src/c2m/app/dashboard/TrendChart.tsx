import { useState } from "react";
import type { Snapshot } from "../types";
import Panel from "../components/Panel";
import { translations, type Language } from "../../translate";

type TrendChartProps = {
  samples: Snapshot[];
  threshold: number;
  parametersReady: boolean;
  dataReady: boolean;
  language: Language;
};

export default function TrendChart({
  samples,
  threshold,
  parametersReady,
  dataReady,
  language,
}: TrendChartProps) {
  const copy = translations[language].dashboard;
  const [metric, setMetric] = useState<"flow" | "pressure">("flow");
  const maxY =
    metric === "flow" ? Math.max(400, threshold * 1.2, ...samples.map((s) => s.flow)) : 10;
  const chartPoints = samples
    .map((s, i) => `${44 + (i / 59) * 700},${164 - (s[metric] / maxY) * 140}`)
    .join(" ");

  return (
    <Panel
      title={copy.liveTrend}
      extra={
        <div className="segmented">
          <button className={metric === "flow" ? "selected" : ""} onClick={() => setMetric("flow")}>
            {copy.flow}
          </button>
          <button
            className={metric === "pressure" ? "selected" : ""}
            onClick={() => setMetric("pressure")}
          >
            {copy.pressure}
          </button>
        </div>
      }
    >
      <div className="chart-meta">
        <span>
          <i className="legend-line" />
          {metric === "flow" ? copy.flowTrend : copy.pressureTrend}
        </span>
        <span>{copy.recentSeconds}</span>
      </div>
      <div
        className="chart"
        style={{ visibility: dataReady ? "visible" : "hidden" }}
        aria-hidden={!dataReady}
      >
        <svg
          viewBox="0 0 770 194"
          role="img"
          aria-label={`${metric === "flow" ? copy.flow : copy.pressure}${copy.trendAria}`}
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0091dc" stopOpacity=".18" />
              <stop offset="100%" stopColor="#0091dc" stopOpacity=".01" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line x1="44" x2="744" y1={24 + i * 35} y2={24 + i * 35} stroke="#e9edef" />
              <text x="33" y={28 + i * 35} textAnchor="end">
                {Math.round(maxY * (1 - i / 4))}
              </text>
            </g>
          ))}
          {metric === "flow" && parametersReady && (
            <line
              x1="44"
              x2="744"
              y1={164 - (threshold / maxY) * 140}
              y2={164 - (threshold / maxY) * 140}
              stroke="#e2ad55"
              strokeDasharray="5 5"
            />
          )}
          <polygon
            points={`44,164 ${chartPoints} ${44 + ((samples.length - 1) / 59) * 700},164`}
            fill="url(#chart-fill)"
          />
          <polyline points={chartPoints} fill="none" stroke="#0091dc" strokeWidth="2.5" />
          {[0, 15, 30, 45, 59].map((i) => (
            <text key={i} x={44 + (i / 59) * 700} y="186" textAnchor="middle">
              {i}s
            </text>
          ))}
        </svg>
      </div>
      <div className="chart-footer">
        <span>
          {metric === "flow" && parametersReady ? `${copy.threshold} ${threshold} l/min` : ""}
        </span>
      </div>
    </Panel>
  );
}
