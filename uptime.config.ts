const pageConfig = {
  // Title for your status page
  title: "Tom's Status Page",
  // Links shown at the header of your status page, could set `highlight` to `true`
  links: [
    { link: 'https://github.com/pl4nty', label: 'GitHub' },
    { link: 'https://tplant.com.au/', label: 'Blog' },
  ],
}

const workerConfig = {
  // Write KV at most every 3 minutes unless the status changed
  kvWriteCooldownMinutes: 3,
  // Enable HTTP Basic auth for status page & API by uncommenting the line below, format `<USERNAME>:<PASSWORD>`
  // passwordProtection: 'username:password',
  // Define all your monitors here
  monitors: [
    {
      id: 'flux-cluster-0.tplant.com.au',
      name: 'flux-cluster-0.tplant.com.au',
      method: 'GET',
      target: 'https://flux-cluster-0.tplant.com.au',
      expectedCodes: [404],
      // checkLocationWorkerRoute: 'https://status-worker.tplant.com.au/',
    },
    {
      id: 'flux-cluster-1.tplant.com.au',
      name: 'flux-cluster-1.tplant.com.au',
      method: 'GET',
      target: 'https://flux-cluster-1.tplant.com.au',
      expectedCodes: [404],
    },
    {
      id: 'flux-cluster-oke.tplant.com.au',
      name: 'flux-cluster-oke.tplant.com.au',
      method: 'GET',
      target: 'https://flux-cluster-oke.tplant.com.au',
      expectedCodes: [404],
    },
    {
      id: 'mta-sts.tplant.com.au',
      name: 'mta-sts.tplant.com.au',
      method: 'GET',
      target: 'https://mta-sts.tplant.com.au/.well-known/mta-sts.txt',
    },
    {
      id: 'files.tplant.com.au',
      name: 'files.tplant.com.au',
      method: 'GET',
      target: 'https://files.tplant.com.au/wright.svg',
    },
    {
      id: 'ataxx.tplant.com.au',
      name: 'ataxx.tplant.com.au',
      method: 'HEAD',
      target: 'https://ataxx.tplant.com.au',
    },
  ],
  notification: {
    // [Optional] apprise API server URL
    // if not specified, no notification will be sent
    appriseApiServer: "https://apprise.example.com/notify",
    // [Optional] recipient URL for apprise, refer to https://github.com/caronc/apprise
    // if not specified, no notification will be sent
    recipientUrl: "tgram://bottoken/ChatID",
    // [Optional] timezone used in notification messages, default to "Etc/GMT"
    timeZone: "Asia/Shanghai",
    // [Optional] grace period in minutes before sending a notification
    // notification will be sent only if the monitor is down for N continuous checks after the initial failure
    // if not specified, notification will be sent immediately
    gracePeriod: 5,
  },
  callbacks: {
    onStatusChange: async (
      env: any,
      monitor: any,
      isUp: boolean,
      timeIncidentStart: number,
      timeNow: number,
      reason: string
    ) => {
      // This callback will be called when there's a status change for any monitor
      // Write any Typescript code here

      // This will not follow the grace period settings and will be called immediately when the status changes
      // You need to handle the grace period manually if you want to implement it
    },
    onIncident: async (
      env: any,
      monitor: any,
      timeIncidentStart: number,
      timeNow: number,
      reason: string
    ) => {
      // This callback will be called EVERY 1 MINTUE if there's an on-going incident for any monitor
      // Write any Typescript code here
    },
  },
}

// Don't forget this, otherwise compilation fails.
export { pageConfig, workerConfig }
