# INAVA Assist – live deployment record

No secrets in this file. The API key and service account key live only in the
Apps Script project's Script Properties.

| Item | Value |
|---|---|
| Google Cloud project | `inava-assist-1027b` (number 708457737006), org bettinienterprises.com |
| Service account | `inava-assist-bot@inava-assist-1027b.iam.gserviceaccount.com` |
| Apps Script project | https://script.google.com/d/1pQqPnUEk4SCiyxr9jwUzrnH_vKoWqe2thn-75GOtXYZjaZhiSJlECyhC/edit |
| Live (versioned) deployment ID | `AKfycbzXpgsO9IRXe01ht1NJ46bVdc2ViG46KWkwZQfgxTFBI5zBsOCyvVDUJRxKz7DSy0Ts` (used by the Chat API config and the Marketplace listing) |
| Test (HEAD) deployment ID | `AKfycbx-gPTGqa9ZFVYETwx_UU8ePYIA-Mb-5fTA6WzChV0` |
| Control sheet | https://docs.google.com/spreadsheets/d/1aVEqs0Gpckt7vn03SSgMzGZdvypY4dVmfBoC4dQFpKk |
| Knowledge folder | https://drive.google.com/drive/folders/1pRQaVYzgTyqW85sLXNrZV2U4ZExchWV2 |
| Terms / privacy / support page | https://docs.google.com/document/d/1-WATI6PEoilC6fJ7XGyyiHBbTGUsp0IQFwWm--1qMkk/edit |

## Releasing a code change

1. `node test/run-tests.js` and `node build.js`, then `clasp push` (updates HEAD only).
2. Release to users: `clasp update-deployment AKfycbzXpgsO9IRXe01ht1NJ46bVdc2ViG46KWkwZQfgxTFBI5zBsOCyvVDUJRxKz7DSy0Ts`
   (or in Apps Script: Deploy > Manage deployments > edit > Version: New version > Deploy).
   The deployment ID stays the same, so Chat and the Marketplace listing need no change.
