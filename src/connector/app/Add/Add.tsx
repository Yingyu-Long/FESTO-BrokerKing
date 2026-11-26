import { useNavigate } from "react-router-dom";
import { AppHeader, useConnectorLanguage } from "../AppLayout";

export default function Add() {
  const navigate = useNavigate();
  const language = useConnectorLanguage();
  const zh = language === "zh";

  return (
    <div className="fwe-app">
      <main className="fwe-add-page">
        <AppHeader />
        <section className="fwe-add-card">
          <div className="fwe-add-form">
            <h1>{zh ? "添加 PLC 设备" : "Add PLC"}</h1>
            <label htmlFor="plc-type">{zh ? "PLC 协议类型 *" : "PLC type *"}</label>
            <select
              id="plc-type"
              defaultValue=""
              onChange={(event) => {
                const route = event.currentTarget.value;
                if (route) navigate(route);
              }}
            >
              <option value="" disabled>
                {zh ? "请选择 PLC 类型以继续" : "Select a PLC type to continue"}
              </option>
              <option value="/add/siemens">Siemens (S7)</option>
              <option value="/add/rockwell">Rockwell (EtherNet/IP)</option>
              <option value="/add/opcua">OPC UA</option>
              <option value="/add/beckhoff">Beckhoff (ADS)</option>
              <option value="/add/modbus">Modbus TCP</option>
            </select>
            <p>
              {zh ? "选择对应的工业协议以配置寄存器或数据块采集" : "Select a PLC type to continue"}
            </p>
          </div>
          <div className="fwe-add-actions">
            <button type="button" className="fwe-save-button" disabled>
              {zh ? "保存" : "Save"}
            </button>
            <button type="button" onClick={() => navigate("/dashboard")}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
