import { useRef, useState } from "react";
import { IconFailure, IconImport } from "@festo-ui/react-icons";
import { useConnectorLanguage } from "./AppLayout";
import { saveCurrentConfiguration } from "./configurationApi";
import { prepareConfiguration, storeConfiguration } from "./configurationImport";
import type { PreparedConfiguration } from "./configurationImport";

type ImportPageProps = {
  onImported: () => void;
  onCancel: () => void;
};

export default function Import({ onImported, onCancel }: ImportPageProps) {
  const language = useConnectorLanguage();
  const zh = language === "zh";
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [pendingConfiguration, setPendingConfiguration] = useState<PreparedConfiguration | null>(
    null,
  );

  const readFile = async (file: File) => {
    setFileName(file.name);
    setError("");
    try {
      if (!file.name.toLowerCase().endsWith(".json")) {
        throw new Error(zh ? "仅支持 .json 格式文件" : "Only .json files are supported");
      }
      setPendingConfiguration(prepareConfiguration(JSON.parse(await file.text())));
    } catch (reason) {
      setPendingConfiguration(null);
      setError(
        reason instanceof Error
          ? reason.message
          : zh
            ? "无法导入配置文件"
            : "Unable to import configuration",
      );
    }
  };

  const confirmImport = async () => {
    if (!pendingConfiguration) return;
    storeConfiguration(pendingConfiguration);
    try {
      await saveCurrentConfiguration();
      onImported();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : zh
            ? "无法保存配置到数据库"
            : "Unable to save configuration",
      );
    }
  };

  return (
    <section className="fwe-import-page">
      <h2>{zh ? "导入连接配置" : "Import configuration"}</h2>
      <div className="fwe-import-container">
        <div className="fwe-import-main">
          <button
            type="button"
            className={`fwe-import-dropzone ${dragging ? "is-dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void readFile(file);
            }}
          >
            <IconImport className="fwe-import-icon" aria-hidden="true" />
            <strong>{zh ? "拖拽配置文件到此处" : "Drag & drop file here"}</strong>
            <span>{zh ? "或" : "or"}</span>
            <span className="fwe-import-browse">{zh ? "浏览本地文件" : "Browse"}</span>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </button>
          <p className="fwe-import-hint">
            {zh ? "支持的文件格式: *.json" : "Supported file format: *.json"}
          </p>
          {fileName && !error && pendingConfiguration && (
            <p className="fwe-import-selected">
              {zh ? `已选择: ${fileName}` : `Selected: ${fileName}`}
            </p>
          )}
          {error && (
            <div className="fwe-import-error" role="alert">
              <IconFailure aria-hidden="true" />
              {error}
            </div>
          )}
        </div>
        <aside className="fwe-import-info">
          <strong>{zh ? "导入 JSON 连接器配置文件" : "Import a JSON configuration file"}</strong>
          <p>
            {zh
              ? "配置文件须包含 messageSources（PLC 数据源）以及 mqttMessageHandler（MQTT 消息处理器）。"
              : "The file must contain the connector configuration, including message sources and the MQTT message handler."}
          </p>
          <p>
            {zh
              ? "导入后的 PLC 连接将替换当前列表并同步至共享 PostgreSQL 数据库。"
              : "Imported PLC connections will replace the current PLC list."}
          </p>
        </aside>
      </div>
      <div className="fwe-import-actions">
        <button type="button" onClick={onCancel}>
          {zh ? "取消" : "Cancel"}
        </button>
        <button
          type="button"
          className="fwe-import-confirm"
          disabled={!pendingConfiguration}
          onClick={() => void confirmImport()}
        >
          {zh ? "确认导入" : "Import"}
        </button>
      </div>
    </section>
  );
}
