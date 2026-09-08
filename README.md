# Smartenance Repair Task Export

A simple local app for exporting Festo AX Smartenance repair tasks to CSV. Connect your API account, select equipment and a date range, then download the results. Each matching repair task is exported as a separate row. Use the Language setting in the header to switch the interface and CSV headers between English and Chinese.

## Install and run

1. Install **Node.js 22.13 or later** from [nodejs.org](https://nodejs.org/).
2. Download this project and extract it to a folder on your computer.
3. Open a terminal in that folder and install the dependencies:

   ```sh
   npm ci
   ```

4. Build and start the app:

   ```sh
   npm run build
   npm start
   ```

5. Open **http://localhost:3000** in your browser.
6. Connect using your **Smartenance Premium API username and password**, or an **access token**. Select equipment and the repair task creation date range, click **Find repair tasks**, then **Export all to CSV**.

Keep the terminal open while using the app. Press **Control+C** to stop it.

## Start again later

Open a terminal in the project folder and run:

```sh
npm start
```

After updating the project, run `npm ci` and `npm run build` again before starting it.

**Port 3000 already in use?** Stop the app in the terminal where it is already running with **Control+C**, then try again.
