declare global {
	namespace NodeJS {
		interface ProcessEnv {
			UPTIMEFLARE_STATE: KVNamespace;
			CLOUDFLARE_ZONE_ID?: string;
			CLOUDFLARE_API_TOKEN?: string;
		}
	}
}

export {};
