# Smartenance Repair Task CSV Export

A local web application for Festo AX Smartenance. Select equipment and a creation date range, preview repair tasks attached to incidents, and export the results as CSV.

## Requirements and startup

Install Node.js 22.13 or later, then run these commands from the project directory:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000>. Keep the terminal open while using the application; press Control+C to stop it.

On macOS, you can also double-click `启动维修导出.command` to start the application and open the browser.

To build and run the local production version:

```sh
npm run build
npm start
```

Both development and production servers bind to the local loopback address.

## Using the application

1. Enter an **Access Token** (with or without the `Bearer ` prefix), or select **API account** and enter your Smartenance Premium API username and password.
2. Connect, search equipment by name or number, and select one, multiple, or all devices.
3. Choose the repair task creation date range and click **Find repair tasks**.
4. Wait for the query to finish, then click **Export all to CSV**. The preview displays 20 rows per page; the export contains all query results.

Credentials are not saved automatically. The browser keeps authentication information in memory; refreshing the page or disconnecting requires signing in again. Requests pass through the local Node.js server to fixed official Festo endpoints. No cloud service or database is configured.

The interface, error messages, CSV headers, and export filenames are in English. Equipment names and repair content retain their original source language. HTML formatting in repair descriptions and incident text is converted to plain text for both the preview and CSV, preserving paragraph and list-item line breaks. Empty editor markup is omitted.

## Date filtering and CSV output

- Filtering uses `repairTasks[].createdAt`, the repair task creation time.
- Dates use UTC+8 (Beijing time), including the entire start and end dates. For example, September 1–8 corresponds to the UTC interval `[August 31 16:00, September 8 16:00)`.
- The application reads every incident page for the selected equipment, then retrieves incident details and their repair tasks. It does not filter incident creation dates, so newer repair tasks attached to older incidents are included.
- Incidents without repair tasks produce no CSV rows. Information and Maintenance logs are excluded.
- Repair outcomes are displayed as **Not recorded**, **Success**, or **Failure**.
- Repair tasks have no separate completion timestamp. The incident's `fixedDateTime` is exported as the incident fix time; it is not a repair task completion time.
- Results are sorted by repair task creation time, newest first.

The CSV uses English headers, a UTF-8 BOM, comma separators, and CRLF line endings. Commas, quotes, and line breaks are escaped. Text that could be interpreted as a spreadsheet formula receives a leading apostrophe.

Exported fields include equipment name, number, and ID; incident number, ID, summary, status, occurrence time, fix time, description, and cause; and repair task ID, description, outcome, creation time, creator, modification time, modifier, comments JSON, and custom fields JSON. All timestamp columns use UTC+8. Images and attachment contents are not downloaded.

## API authentication and data access

References: [Festo API documentation](https://developers.festo.com/docs/digismartenance-premiumpublicprod/1/overview) and [Smartenance authentication](https://developers.festo.com/smartenance-authentication).

- API base URL: `https://api.festo.com/apps/smartenance/v1`.
- Requests use `Authorization: Bearer <access_token>` and request English responses where applicable using `SMRTNC-LANGUAGE: en`.
- Read endpoints: `GET /machines`, `GET /incidents?machineId=...&offset=...&limit=...`, and `GET /incidents/{logId}`.
- Equipment is loaded using the official `limit=-1` parameter and checked against the returned total. There is no 200-device loading limit or 500-device selection limit.
- Incident lists use the documented `items/count/offset/total` pagination fields, reading every page in batches of 200.
- The API account must have permission to read both incident lists and incident details. A regular website login may not have Premium API access.
- A 401 response stops the request without retrying the invalid token. Responses with status 403 or 429 show the relevant access or waiting information without automatic retries.

The authentication documentation lists `b2c_1_apisignin_ropc` in its main URL and `b2c_1_ropc_apisignin` in its example. API account login defaults to the first policy; the second can be selected under **Trouble signing in?**. The application does not automatically try multiple password requests. An existing access token can be used directly.

## Limits and consistency

If any equipment, page, or detail request fails, the whole query fails and partial results cannot be exported as a complete CSV. Queries support cancellation and a 30-second timeout per request. Detected pagination total changes or duplicate records require a new query.

To control memory usage, the application allows up to 100,000 scanned logs per device and 100,000 exported repair tasks. Exceeding a limit produces an explicit error. Queries may take time for equipment with extensive incident history, even when the selected repair task date range is short.

The API does not guarantee a consistent snapshot across requests. Prefer querying when records are not undergoing bulk edits. Data has not been verified against your live account; compare a small date range for one device with Smartenance before relying on larger exports.

## Development

```sh
npm run typecheck
npm run build
```

Project structure:

- `app/page.tsx`: connection form, equipment and date filters, results preview, and CSV download.
- `app/api/connect/route.ts`: API account or token connection and equipment loading.
- `app/api/repairs/route.ts`: streamed query progress and complete results.
- `lib/festo/`: API client, pagination, filtering, CSV generation, and request validation.
- `docs/api-reference.json`: reference extract of the official endpoints and response fields used by the application.
- `public/brand-icon.png`: header and browser tab icon. Its original asset is `assets/tsconfig.json`, which is a PNG image despite its filename.

Built with React, TypeScript, and Vinext, using Node.js for local API requests. Optional WebMCP tools share the interface's query and export logic and do not return authentication credentials.
