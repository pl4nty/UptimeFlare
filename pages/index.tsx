import Head from 'next/head'

import { Inter } from 'next/font/google'
import { MonitorState, MonitorTarget } from '@/uptime.types'
import { KVNamespace } from '@cloudflare/workers-types'
import { pageConfig, workerConfig } from '@/uptime.config'
import OverallStatus from '@/components/OverallStatus'
import Header from '@/components/Header'
import MonitorList from '@/components/MonitorList'
import { Center, Divider, Text } from '@mantine/core'
import MonitorDetail from '@/components/MonitorDetail'

import { dnsRecords } from 'cloudflare-client'

export const runtime = 'experimental-edge'
const inter = Inter({ subsets: ['latin'] })

export default function Home({
  state: stateStr,
  monitors,
}: {
  state: string
  monitors: MonitorTarget[]
  tooltip?: string
  statusPageLink?: string
}) {
  let state;
  if (stateStr !== undefined) {
    state = JSON.parse(stateStr) as MonitorState
  }

  // Specify monitorId in URL hash to view a specific monitor (can be used in iframe)
  const monitorId = window.location.hash.substring(1);
  if (monitorId) {
    const monitor = monitors.find((monitor) => monitor.id === monitorId);
    if (!monitor || !state) {
      return (
        <Text fw={700}>
          Monitor with id {monitorId} not found!
        </Text>
      )
    }
    return (
      <div style={{ maxWidth: '810px' }}>
        <MonitorDetail monitor={monitor} state={state} />
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>{pageConfig.title}</title>
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={inter.className}>
        <Header />

        {state === undefined ? (
          <Center>
            <Text fw={700}>
              Monitor State is not defined now, please check your worker&apos;s status and KV
              binding!
            </Text>
          </Center>
        ) : (
          <div>
            <OverallStatus state={state} />
            <MonitorList monitors={monitors} state={state} />
          </div>
        )}

        <Divider mt="lg" />
        <Text size="xs" mt="xs" mb="xs" style={{
          textAlign: 'center'
        }}>
          Open-source monitoring and status page powered by{' '}
          <a href="https://github.com/lyc8503/UptimeFlare" target="_blank">
            Uptimeflare
          </a>{' '}
          and{' '}
          <a href="https://www.cloudflare.com/" target="_blank">
            Cloudflare
          </a>
          , made with ❤ by{' '}
          <a href="https://github.com/lyc8503" target="_blank">
            lyc8503
          </a>
          .
        </Text>
      </main>
    </>
  )
}

export async function getServerSideProps() {
  const { UPTIMEFLARE_STATE, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN } = process.env as unknown as {
    UPTIMEFLARE_STATE: KVNamespace,
    CLOUDFLARE_ZONE_ID: string,
    CLOUDFLARE_API_TOKEN: string
  }

  // Read state as string from KV, to avoid hitting server-side cpu time limit
  const state = (await UPTIMEFLARE_STATE?.get('state')) as unknown as MonitorState

  // load monitors from Cloudflare proxied DNS records. official API only supports node
  let cfMonitors: { id: string, name: string, tooltip: string }[] = []
  try {
    const cf = dnsRecords({
      zoneId: CLOUDFLARE_ZONE_ID,
      accessToken: CLOUDFLARE_API_TOKEN
    })
    const records = await cf.find({ proxied: true }).all()
    
    cfMonitors = records.map(monitor => ({
      id: monitor.name,
      name: monitor.name,
      tooltip: `https://${monitor.name}/`,
    }))
  } catch(err) {
    console.log(`Skipping Cloudflare auto-discovery: ${err}`)
  }

  // Only present these values to client
  let monitors = workerConfig.monitors.map(monitor => {
    return {
      id: monitor.id,
      name: monitor.name,
      // @ts-ignore
      tooltip: monitor?.tooltip,
      // @ts-ignore
      statusPageLink: monitor?.statusPageLink
    }
  }).concat(cfMonitors)
  monitors = monitors.reduce((acc, curr) => {
    if (!acc.find(item => item.id === curr.id)) acc.push(curr)
    return acc
  }, [] as any[])

  return { props: { state, monitors } }
}
