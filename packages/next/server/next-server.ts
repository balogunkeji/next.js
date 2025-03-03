import type { __ApiPreviewProps } from './api-utils'
import type { CustomRoutes, Header } from '../lib/load-custom-routes'
import type { DomainLocale } from './config'
import type { DynamicRoutes, PageChecker, Params, Route } from './router'
import type { FetchEventResult } from './web/types'
import type { FontManifest } from './font-utils'
import type { IncomingMessage, ServerResponse } from 'http'
import type { LoadComponentsReturnType } from './load-components'
import type { MiddlewareManifest } from '../build/webpack/plugins/middleware-plugin'
import type { NextApiRequest, NextApiResponse } from '../shared/lib/utils'
import type { NextConfigComplete } from './config-shared'
import type { NextParsedUrlQuery, NextUrlWithParsedQuery } from './request-meta'
import type { ParsedNextUrl } from '../shared/lib/router/utils/parse-next-url'
import type { ParsedUrl } from '../shared/lib/router/utils/parse-url'
import type { ParsedUrlQuery } from 'querystring'
import type { PrerenderManifest } from '../build'
import type { Redirect, Rewrite, RouteType } from '../lib/load-custom-routes'
import type { RenderOpts, RenderOptsPartial } from './render'
import type { ResponseCacheEntry, ResponseCacheValue } from './response-cache'
import type { UrlWithParsedQuery } from 'url'

import compression from 'next/dist/compiled/compression'
import fs from 'fs'
import Proxy from 'next/dist/compiled/http-proxy'
import { join, relative, resolve, sep } from 'path'
import { parse as parseQs, stringify as stringifyQs } from 'querystring'
import { format as formatUrl, parse as parseUrl } from 'url'
import { getRedirectStatus, modifyRouteRegex } from '../lib/load-custom-routes'
import {
  BUILD_ID_FILE,
  CLIENT_PUBLIC_FILES_PATH,
  CLIENT_STATIC_FILES_PATH,
  CLIENT_STATIC_FILES_RUNTIME,
  PAGES_MANIFEST,
  PERMANENT_REDIRECT_STATUS,
  PRERENDER_MANIFEST,
  ROUTES_MANIFEST,
  SERVERLESS_DIRECTORY,
  SERVER_DIRECTORY,
  STATIC_STATUS_PAGES,
  TEMPORARY_REDIRECT_STATUS,
  MIDDLEWARE_MANIFEST,
} from '../shared/lib/constants'
import {
  getRouteMatcher,
  getRouteRegex,
  getSortedRoutes,
  isDynamicRoute,
  getMiddlewareRegex,
} from '../shared/lib/router/utils'
import * as envConfig from '../shared/lib/runtime-config'
import {
  DecodeError,
  isResSent,
  normalizeRepeatedSlashes,
} from '../shared/lib/utils'
import {
  apiResolver,
  setLazyProp,
  getCookieParser,
  tryGetPreviewData,
} from './api-utils'
import { isTargetLikeServerless } from './config'
import pathMatch from '../shared/lib/router/utils/path-match'
import { recursiveReadDirSync } from './lib/recursive-readdir-sync'
import { loadComponents } from './load-components'
import { normalizePagePath } from './normalize-page-path'
import { renderToHTML } from './render'
import { getPagePath, requireFontManifest } from './require'
import Router, { replaceBasePath, route } from './router'
import {
  compileNonPath,
  prepareDestination,
} from '../shared/lib/router/utils/prepare-destination'
import { sendRenderResult, setRevalidateHeaders } from './send-payload'
import { serveStatic } from './serve-static'
import { IncrementalCache } from './incremental-cache'
import { execOnce } from '../shared/lib/utils'
import { isBlockedPage, isBot } from './utils'
import RenderResult from './render-result'
import { loadEnvConfig } from '@next/env'
import './node-polyfill-fetch'
import { PagesManifest } from '../build/webpack/plugins/pages-manifest-plugin'
import { removePathTrailingSlash } from '../client/normalize-trailing-slash'
import getRouteFromAssetPath from '../shared/lib/router/utils/get-route-from-asset-path'
import { denormalizePagePath } from './denormalize-page-path'
import { normalizeLocalePath } from '../shared/lib/i18n/normalize-locale-path'
import * as Log from '../build/output/log'
import { detectDomainLocale } from '../shared/lib/i18n/detect-domain-locale'
import escapePathDelimiters from '../shared/lib/router/utils/escape-path-delimiters'
import { getUtils } from '../build/webpack/loaders/next-serverless-loader/utils'
import { PreviewData } from 'next/types'
import ResponseCache from './response-cache'
import { parseNextUrl } from '../shared/lib/router/utils/parse-next-url'
import isError from '../lib/is-error'
import { getMiddlewareInfo } from './require'
import { MIDDLEWARE_ROUTE } from '../lib/constants'
import { NextResponse } from './web/spec-extension/response'
import { run } from './web/sandbox'
import { addRequestMeta, getRequestMeta } from './request-meta'
import { toNodeHeaders } from './web/utils'

const getCustomRouteMatcher = pathMatch(true)

type ExpressMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: Error) => void
) => void

export type FindComponentsResult = {
  components: LoadComponentsReturnType
  query: NextParsedUrlQuery
}

interface RoutingItem {
  page: string
  match: ReturnType<typeof getRouteMatcher>
  ssr?: boolean
}

export interface Options {
  /**
   * Object containing the configuration next.config.js
   */
  conf: NextConfigComplete
  /**
   * Set to false when the server was created by Next.js
   */
  customServer?: boolean
  /**
   * Tells if Next.js is running in dev mode
   */
  dev?: boolean
  /**
   * Where the Next project is located
   */
  dir?: string
  /**
   * Tells if Next.js is running in a Serverless platform
   */
  minimalMode?: boolean
  /**
   * Hide error messages containing server information
   */
  quiet?: boolean
  /**
   * The hostname the server is running behind
   */
  hostname?: string
  /**
   * The port the server is running behind
   */
  port?: number
}

export interface RequestHandler {
  (
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl?: NextUrlWithParsedQuery | undefined
  ): Promise<void>
}

type RequestContext = {
  req: IncomingMessage
  res: ServerResponse
  pathname: string
  query: NextParsedUrlQuery
  renderOpts: RenderOptsPartial
}

export default class Server {
  protected dir: string
  protected quiet: boolean
  protected nextConfig: NextConfigComplete
  protected distDir: string
  protected pagesDir?: string
  protected publicDir: string
  protected hasStaticDir: boolean
  protected serverBuildDir: string
  protected pagesManifest?: PagesManifest
  protected buildId: string
  protected minimalMode: boolean
  protected renderOpts: {
    poweredByHeader: boolean
    buildId: string
    generateEtags: boolean
    runtimeConfig?: { [key: string]: any }
    assetPrefix?: string
    canonicalBase: string
    dev?: boolean
    previewProps: __ApiPreviewProps
    customServer?: boolean
    ampOptimizerConfig?: { [key: string]: any }
    basePath: string
    optimizeFonts: boolean
    images: string
    fontManifest: FontManifest
    optimizeImages: boolean
    disableOptimizedLoading?: boolean
    optimizeCss: any
    locale?: string
    locales?: string[]
    defaultLocale?: string
    domainLocales?: DomainLocale[]
    distDir: string
    concurrentFeatures?: boolean
    crossOrigin?: string
  }
  private compression?: ExpressMiddleware
  private incrementalCache: IncrementalCache
  private responseCache: ResponseCache
  protected router: Router
  protected dynamicRoutes?: DynamicRoutes
  protected customRoutes: CustomRoutes
  protected middlewareManifest?: MiddlewareManifest
  protected middleware?: RoutingItem[]
  public readonly hostname?: string
  public readonly port?: number

  public constructor({
    dir = '.',
    quiet = false,
    conf,
    dev = false,
    minimalMode = false,
    customServer = true,
    hostname,
    port,
  }: Options) {
    this.dir = resolve(dir)
    this.quiet = quiet
    loadEnvConfig(this.dir, dev, Log)

    this.nextConfig = conf
    this.hostname = hostname
    this.port = port

    this.distDir = join(this.dir, this.nextConfig.distDir)
    this.publicDir = join(this.dir, CLIENT_PUBLIC_FILES_PATH)
    this.hasStaticDir = !minimalMode && fs.existsSync(join(this.dir, 'static'))

    // Only serverRuntimeConfig needs the default
    // publicRuntimeConfig gets it's default in client/index.js
    const {
      serverRuntimeConfig = {},
      publicRuntimeConfig,
      assetPrefix,
      generateEtags,
      compress,
    } = this.nextConfig

    this.buildId = this.readBuildId()
    this.minimalMode = minimalMode

    this.renderOpts = {
      poweredByHeader: this.nextConfig.poweredByHeader,
      canonicalBase: this.nextConfig.amp.canonicalBase || '',
      buildId: this.buildId,
      generateEtags,
      previewProps: this.getPreviewProps(),
      customServer: customServer === true ? true : undefined,
      ampOptimizerConfig: this.nextConfig.experimental.amp?.optimizer,
      basePath: this.nextConfig.basePath,
      images: JSON.stringify(this.nextConfig.images),
      optimizeFonts: !!this.nextConfig.optimizeFonts && !dev,
      fontManifest:
        this.nextConfig.optimizeFonts && !dev
          ? requireFontManifest(this.distDir, this._isLikeServerless)
          : null,
      optimizeImages: !!this.nextConfig.experimental.optimizeImages,
      optimizeCss: this.nextConfig.experimental.optimizeCss,
      disableOptimizedLoading:
        this.nextConfig.experimental.disableOptimizedLoading,
      domainLocales: this.nextConfig.i18n?.domains,
      distDir: this.distDir,
      concurrentFeatures: this.nextConfig.experimental.concurrentFeatures,
      crossOrigin: this.nextConfig.crossOrigin
        ? this.nextConfig.crossOrigin
        : undefined,
    }

    // Only the `publicRuntimeConfig` key is exposed to the client side
    // It'll be rendered as part of __NEXT_DATA__ on the client side
    if (Object.keys(publicRuntimeConfig).length > 0) {
      this.renderOpts.runtimeConfig = publicRuntimeConfig
    }

    if (compress && this.nextConfig.target === 'server') {
      this.compression = compression() as ExpressMiddleware
    }

    // Initialize next/config with the environment configuration
    envConfig.setConfig({
      serverRuntimeConfig,
      publicRuntimeConfig,
    })

    this.serverBuildDir = join(
      this.distDir,
      this._isLikeServerless ? SERVERLESS_DIRECTORY : SERVER_DIRECTORY
    )
    const pagesManifestPath = join(this.serverBuildDir, PAGES_MANIFEST)
    const middlewareManifestPath = join(
      join(this.distDir, SERVER_DIRECTORY),
      MIDDLEWARE_MANIFEST
    )

    if (!dev) {
      this.pagesManifest = require(pagesManifestPath)
      if (!this.minimalMode) {
        this.middlewareManifest = require(middlewareManifestPath)
      }
    }

    this.customRoutes = this.getCustomRoutes()
    this.router = new Router(this.generateRoutes())
    this.setAssetPrefix(assetPrefix)

    this.incrementalCache = new IncrementalCache({
      dev,
      distDir: this.distDir,
      pagesDir: join(
        this.distDir,
        this._isLikeServerless ? SERVERLESS_DIRECTORY : SERVER_DIRECTORY,
        'pages'
      ),
      locales: this.nextConfig.i18n?.locales,
      max: this.nextConfig.experimental.isrMemoryCacheSize,
      flushToDisk: !minimalMode && this.nextConfig.experimental.isrFlushToDisk,
    })
    this.responseCache = new ResponseCache(this.incrementalCache)

    /**
     * This sets environment variable to be used at the time of SSR by head.tsx.
     * Using this from process.env allows targeting both serverless and SSR by calling
     * `process.env.__NEXT_OPTIMIZE_IMAGES`.
     * TODO(atcastle@): Remove this when experimental.optimizeImages are being cleaned up.
     */
    if (this.renderOpts.optimizeFonts) {
      process.env.__NEXT_OPTIMIZE_FONTS = JSON.stringify(true)
    }
    if (this.renderOpts.optimizeImages) {
      process.env.__NEXT_OPTIMIZE_IMAGES = JSON.stringify(true)
    }
    if (this.renderOpts.optimizeCss) {
      process.env.__NEXT_OPTIMIZE_CSS = JSON.stringify(true)
    }
  }

  public logError(err: Error): void {
    if (this.quiet) return
    console.error(err)
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl?: NextUrlWithParsedQuery
  ): Promise<void> {
    const urlParts = (req.url || '').split('?')
    const urlNoQuery = urlParts[0]

    if (urlNoQuery?.match(/(\\|\/\/)/)) {
      const cleanUrl = normalizeRepeatedSlashes(req.url!)
      res.setHeader('Location', cleanUrl)
      res.setHeader('Refresh', `0;url=${cleanUrl}`)
      res.statusCode = 308
      res.end(cleanUrl)
      return
    }

    setLazyProp({ req: req as any }, 'cookies', getCookieParser(req.headers))

    // Parse url if parsedUrl not provided
    if (!parsedUrl || typeof parsedUrl !== 'object') {
      parsedUrl = parseUrl(req.url!, true)
    }

    // Parse the querystring ourselves if the user doesn't handle querystring parsing
    if (typeof parsedUrl.query === 'string') {
      parsedUrl.query = parseQs(parsedUrl.query)
    }

    addRequestMeta(req, '__NEXT_INIT_URL', req.url)
    addRequestMeta(req, '__NEXT_INIT_QUERY', { ...parsedUrl.query })

    const url = parseNextUrl({
      headers: req.headers,
      nextConfig: this.nextConfig,
      url: req.url?.replace(/^\/+/, '/'),
    })

    if (url.basePath) {
      req.url = replaceBasePath(req.url!, this.nextConfig.basePath)
      addRequestMeta(req, '_nextHadBasePath', true)
    }

    if (
      this.minimalMode &&
      req.headers['x-matched-path'] &&
      typeof req.headers['x-matched-path'] === 'string'
    ) {
      const reqUrlIsDataUrl = req.url?.includes('/_next/data')
      const matchedPathIsDataUrl =
        req.headers['x-matched-path']?.includes('/_next/data')
      const isDataUrl = reqUrlIsDataUrl || matchedPathIsDataUrl

      let parsedPath = parseUrl(
        isDataUrl ? req.url! : (req.headers['x-matched-path'] as string),
        true
      )

      let matchedPathname = parsedPath.pathname!

      let matchedPathnameNoExt = isDataUrl
        ? matchedPathname.replace(/\.json$/, '')
        : matchedPathname

      if (this.nextConfig.i18n) {
        const localePathResult = normalizeLocalePath(
          matchedPathname || '/',
          this.nextConfig.i18n.locales
        )

        if (localePathResult.detectedLocale) {
          parsedUrl.query.__nextLocale = localePathResult.detectedLocale
        }
      }

      if (isDataUrl) {
        matchedPathname = denormalizePagePath(matchedPathname)
        matchedPathnameNoExt = denormalizePagePath(matchedPathnameNoExt)
      }

      const pageIsDynamic = isDynamicRoute(matchedPathnameNoExt)
      const combinedRewrites: Rewrite[] = []

      combinedRewrites.push(...this.customRoutes.rewrites.beforeFiles)
      combinedRewrites.push(...this.customRoutes.rewrites.afterFiles)
      combinedRewrites.push(...this.customRoutes.rewrites.fallback)

      const utils = getUtils({
        pageIsDynamic,
        page: matchedPathnameNoExt,
        i18n: this.nextConfig.i18n,
        basePath: this.nextConfig.basePath,
        rewrites: combinedRewrites,
      })

      try {
        // ensure parsedUrl.pathname includes URL before processing
        // rewrites or they won't match correctly
        if (this.nextConfig.i18n && !url.locale?.path.detectedLocale) {
          parsedUrl.pathname = `/${url.locale?.locale}${parsedUrl.pathname}`
        }
        utils.handleRewrites(req, parsedUrl)

        // interpolate dynamic params and normalize URL if needed
        if (pageIsDynamic) {
          let params: ParsedUrlQuery | false = {}

          Object.assign(parsedUrl.query, parsedPath.query)
          const paramsResult = utils.normalizeDynamicRouteParams(
            parsedUrl.query
          )

          if (paramsResult.hasValidParams) {
            params = paramsResult.params
          } else if (req.headers['x-now-route-matches']) {
            const opts: Record<string, string> = {}
            params = utils.getParamsFromRouteMatches(
              req,
              opts,
              parsedUrl.query.__nextLocale || ''
            )

            if (opts.locale) {
              parsedUrl.query.__nextLocale = opts.locale
            }
          } else {
            params = utils.dynamicRouteMatcher!(matchedPathnameNoExt)
          }

          if (params) {
            params = utils.normalizeDynamicRouteParams(params).params

            matchedPathname = utils.interpolateDynamicPath(
              matchedPathname,
              params
            )
            req.url = utils.interpolateDynamicPath(req.url!, params)
          }

          if (reqUrlIsDataUrl && matchedPathIsDataUrl) {
            req.url = formatUrl({
              ...parsedPath,
              pathname: matchedPathname,
            })
          }

          Object.assign(parsedUrl.query, params)
          utils.normalizeVercelUrl(req, true)
        }
      } catch (err) {
        if (err instanceof DecodeError) {
          res.statusCode = 400
          return this.renderError(null, req, res, '/_error', {})
        }
        throw err
      }

      parsedUrl.pathname = `${this.nextConfig.basePath || ''}${
        matchedPathname === '/' && this.nextConfig.basePath
          ? ''
          : matchedPathname
      }`
      url.pathname = parsedUrl.pathname
    }

    addRequestMeta(req, '__nextHadTrailingSlash', url.locale?.trailingSlash)
    if (url.locale?.domain) {
      addRequestMeta(req, '__nextIsLocaleDomain', true)
    }

    if (url.locale?.path.detectedLocale) {
      req.url = formatUrl(url)
      addRequestMeta(req, '__nextStrippedLocale', true)
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return this.render404(req, res, parsedUrl)
      }
    }

    if (!this.minimalMode || !parsedUrl.query.__nextLocale) {
      if (url?.locale?.locale) {
        parsedUrl.query.__nextLocale = url.locale.locale
      }
    }

    if (url?.locale?.defaultLocale) {
      parsedUrl.query.__nextDefaultLocale = url.locale.defaultLocale
    }

    if (url.locale?.redirect) {
      res.setHeader('Location', url.locale.redirect)
      res.statusCode = TEMPORARY_REDIRECT_STATUS
      res.end()
      return
    }

    res.statusCode = 200
    try {
      return await this.run(req, res, parsedUrl)
    } catch (err) {
      if (this.minimalMode || this.renderOpts.dev) {
        throw err
      }
      this.logError(isError(err) ? err : new Error(err + ''))
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  }

  public getRequestHandler(): RequestHandler {
    return this.handleRequest.bind(this)
  }

  public setAssetPrefix(prefix?: string): void {
    this.renderOpts.assetPrefix = prefix ? prefix.replace(/\/$/, '') : ''
  }

  // Backwards compatibility
  public async prepare(): Promise<void> {}

  // Backwards compatibility
  protected async close(): Promise<void> {}

  protected setImmutableAssetCacheControl(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }

  protected getCustomRoutes(): CustomRoutes {
    const customRoutes = require(join(this.distDir, ROUTES_MANIFEST))
    let rewrites: CustomRoutes['rewrites']

    // rewrites can be stored as an array when an array is
    // returned in next.config.js so massage them into
    // the expected object format
    if (Array.isArray(customRoutes.rewrites)) {
      rewrites = {
        beforeFiles: [],
        afterFiles: customRoutes.rewrites,
        fallback: [],
      }
    } else {
      rewrites = customRoutes.rewrites
    }
    return Object.assign(customRoutes, { rewrites })
  }

  private _cachedPreviewManifest: PrerenderManifest | undefined
  protected getPrerenderManifest(): PrerenderManifest {
    if (this._cachedPreviewManifest) {
      return this._cachedPreviewManifest
    }
    const manifest = require(join(this.distDir, PRERENDER_MANIFEST))
    return (this._cachedPreviewManifest = manifest)
  }

  protected getPreviewProps(): __ApiPreviewProps {
    return this.getPrerenderManifest().preview
  }

  protected getMiddleware() {
    const middleware = this.middlewareManifest?.middleware || {}
    return (
      this.middlewareManifest?.sortedMiddleware.map((page) => ({
        match: getRouteMatcher(
          getMiddlewareRegex(page, MIDDLEWARE_ROUTE.test(middleware[page].name))
        ),
        page,
      })) || []
    )
  }

  protected async hasMiddleware(
    pathname: string,
    _isSSR?: boolean
  ): Promise<boolean> {
    try {
      return (
        getMiddlewareInfo({
          dev: this.renderOpts.dev,
          distDir: this.distDir,
          page: pathname,
          serverless: this._isLikeServerless,
        }).paths.length > 0
      )
    } catch (_) {}

    return false
  }

  protected async ensureMiddleware(_pathname: string, _isSSR?: boolean) {}

  private middlewareBetaWarning = execOnce(() => {
    Log.warn(
      `using beta Middleware (not covered by semver) - https://nextjs.org/docs/messages/beta-middleware`
    )
  })

  protected async runMiddleware(params: {
    request: IncomingMessage
    response: ServerResponse
    parsedUrl: ParsedNextUrl
    parsed: UrlWithParsedQuery
    onWarning?: (warning: Error) => void
  }): Promise<FetchEventResult | null> {
    this.middlewareBetaWarning()

    const page: { name?: string; params?: { [key: string]: string } } = {}
    if (await this.hasPage(params.parsedUrl.pathname)) {
      page.name = params.parsedUrl.pathname
    } else if (this.dynamicRoutes) {
      for (const dynamicRoute of this.dynamicRoutes) {
        const matchParams = dynamicRoute.match(params.parsedUrl.pathname)
        if (matchParams) {
          page.name = dynamicRoute.page
          page.params = matchParams
          break
        }
      }
    }

    const subreq = params.request.headers[`x-middleware-subrequest`]
    const subrequests = typeof subreq === 'string' ? subreq.split(':') : []
    const allHeaders = new Headers()
    let result: FetchEventResult | null = null

    for (const middleware of this.middleware || []) {
      if (middleware.match(params.parsedUrl.pathname)) {
        if (!(await this.hasMiddleware(middleware.page, middleware.ssr))) {
          console.warn(`The Edge Function for ${middleware.page} was not found`)
          continue
        }

        await this.ensureMiddleware(middleware.page, middleware.ssr)

        const middlewareInfo = getMiddlewareInfo({
          dev: this.renderOpts.dev,
          distDir: this.distDir,
          page: middleware.page,
          serverless: this._isLikeServerless,
        })

        if (subrequests.includes(middlewareInfo.name)) {
          result = {
            response: NextResponse.next(),
            waitUntil: Promise.resolve(),
          }
          continue
        }

        result = await run({
          name: middlewareInfo.name,
          paths: middlewareInfo.paths,
          request: {
            headers: params.request.headers,
            method: params.request.method || 'GET',
            nextConfig: {
              basePath: this.nextConfig.basePath,
              i18n: this.nextConfig.i18n,
              trailingSlash: this.nextConfig.trailingSlash,
            },
            url: getRequestMeta(params.request, '__NEXT_INIT_URL')!,
            page: page,
          },
          useCache: !this.nextConfig.experimental.concurrentFeatures,
          onWarning: (warning: Error) => {
            if (params.onWarning) {
              warning.message += ` "./${middlewareInfo.name}"`
              params.onWarning(warning)
            }
          },
        })

        for (let [key, value] of result.response.headers) {
          if (key !== 'x-middleware-next') {
            allHeaders.append(key, value)
          }
        }

        if (!this.renderOpts.dev) {
          result.waitUntil.catch((error) => {
            console.error(`Uncaught: middleware waitUntil errored`, error)
          })
        }

        if (!result.response.headers.has('x-middleware-next')) {
          break
        }
      }
    }

    if (!result) {
      this.render404(params.request, params.response, params.parsed)
    } else {
      for (let [key, value] of allHeaders) {
        result.response.headers.set(key, value)
      }
    }

    return result
  }

  protected generateRoutes(): {
    basePath: string
    headers: Route[]
    rewrites: {
      beforeFiles: Route[]
      afterFiles: Route[]
      fallback: Route[]
    }
    fsRoutes: Route[]
    redirects: Route[]
    catchAllRoute: Route
    catchAllMiddleware?: Route
    pageChecker: PageChecker
    useFileSystemPublicRoutes: boolean
    dynamicRoutes: DynamicRoutes | undefined
    locales: string[]
  } {
    const server: Server = this
    const publicRoutes = fs.existsSync(this.publicDir)
      ? this.generatePublicRoutes()
      : []

    const staticFilesRoute = this.hasStaticDir
      ? [
          {
            // It's very important to keep this route's param optional.
            // (but it should support as many params as needed, separated by '/')
            // Otherwise this will lead to a pretty simple DOS attack.
            // See more: https://github.com/vercel/next.js/issues/2617
            match: route('/static/:path*'),
            name: 'static catchall',
            fn: async (req, res, params, parsedUrl) => {
              const p = join(this.dir, 'static', ...params.path)
              await this.serveStatic(req, res, p, parsedUrl)
              return {
                finished: true,
              }
            },
          } as Route,
        ]
      : []

    const fsRoutes: Route[] = [
      {
        match: route('/_next/static/:path*'),
        type: 'route',
        name: '_next/static catchall',
        fn: async (req, res, params, parsedUrl) => {
          // make sure to 404 for /_next/static itself
          if (!params.path) {
            await this.render404(req, res, parsedUrl)
            return {
              finished: true,
            }
          }

          if (
            params.path[0] === CLIENT_STATIC_FILES_RUNTIME ||
            params.path[0] === 'chunks' ||
            params.path[0] === 'css' ||
            params.path[0] === 'image' ||
            params.path[0] === 'media' ||
            params.path[0] === this.buildId ||
            params.path[0] === 'pages' ||
            params.path[1] === 'pages'
          ) {
            this.setImmutableAssetCacheControl(res)
          }
          const p = join(
            this.distDir,
            CLIENT_STATIC_FILES_PATH,
            ...(params.path || [])
          )
          await this.serveStatic(req, res, p, parsedUrl)
          return {
            finished: true,
          }
        },
      },
      {
        match: route('/_next/data/:path*'),
        type: 'route',
        name: '_next/data catchall',
        fn: async (req, res, params, _parsedUrl) => {
          // Make sure to 404 for /_next/data/ itself and
          // we also want to 404 if the buildId isn't correct
          if (!params.path || params.path[0] !== this.buildId) {
            await this.render404(req, res, _parsedUrl)
            return {
              finished: true,
            }
          }
          // remove buildId from URL
          params.path.shift()

          const lastParam = params.path[params.path.length - 1]

          // show 404 if it doesn't end with .json
          if (typeof lastParam !== 'string' || !lastParam.endsWith('.json')) {
            await this.render404(req, res, _parsedUrl)
            return {
              finished: true,
            }
          }

          // re-create page's pathname
          let pathname = `/${params.path.join('/')}`
          pathname = getRouteFromAssetPath(pathname, '.json')

          if (this.nextConfig.i18n) {
            const { host } = req?.headers || {}
            // remove port from host and remove port if present
            const hostname = host?.split(':')[0].toLowerCase()
            const localePathResult = normalizeLocalePath(
              pathname,
              this.nextConfig.i18n.locales
            )
            const { defaultLocale } =
              detectDomainLocale(this.nextConfig.i18n.domains, hostname) || {}

            let detectedLocale = ''

            if (localePathResult.detectedLocale) {
              pathname = localePathResult.pathname
              detectedLocale = localePathResult.detectedLocale
            }

            _parsedUrl.query.__nextLocale = detectedLocale
            _parsedUrl.query.__nextDefaultLocale =
              defaultLocale || this.nextConfig.i18n.defaultLocale

            if (!detectedLocale) {
              _parsedUrl.query.__nextLocale =
                _parsedUrl.query.__nextDefaultLocale
              await this.render404(req, res, _parsedUrl)
              return { finished: true }
            }
          }

          const parsedUrl = parseUrl(pathname, true)

          await this.render(
            req,
            res,
            pathname,
            { ..._parsedUrl.query, _nextDataReq: '1' },
            parsedUrl
          )
          return {
            finished: true,
          }
        },
      },
      {
        match: route('/_next/image'),
        type: 'route',
        name: '_next/image catchall',
        fn: (req, res, _params, parsedUrl) => {
          if (this.minimalMode) {
            res.statusCode = 400
            res.end('Bad Request')
            return {
              finished: true,
            }
          }
          const { imageOptimizer } =
            require('./image-optimizer') as typeof import('./image-optimizer')

          return imageOptimizer(
            server,
            req,
            res,
            parsedUrl,
            server.nextConfig,
            server.distDir,
            this.renderOpts.dev
          )
        },
      },
      {
        match: route('/_next/:path*'),
        type: 'route',
        name: '_next catchall',
        // This path is needed because `render()` does a check for `/_next` and the calls the routing again
        fn: async (req, res, _params, parsedUrl) => {
          await this.render404(req, res, parsedUrl)
          return {
            finished: true,
          }
        },
      },
      ...publicRoutes,
      ...staticFilesRoute,
    ]

    const restrictedRedirectPaths = ['/_next'].map((p) =>
      this.nextConfig.basePath ? `${this.nextConfig.basePath}${p}` : p
    )

    const getCustomRoute = (
      r: Rewrite | Redirect | Header,
      type: RouteType
    ) => {
      const match = getCustomRouteMatcher(
        r.source,
        !(r as any).internal
          ? (regex: string) =>
              modifyRouteRegex(
                regex,
                type === 'redirect' ? restrictedRedirectPaths : undefined
              )
          : undefined
      )

      return {
        ...r,
        type,
        match,
        name: type,
        fn: async (_req, _res, _params, _parsedUrl) => ({ finished: false }),
      } as Route & Rewrite & Header
    }

    // Headers come very first
    const headers = this.minimalMode
      ? []
      : this.customRoutes.headers.map((r) => {
          const headerRoute = getCustomRoute(r, 'header')
          return {
            match: headerRoute.match,
            has: headerRoute.has,
            type: headerRoute.type,
            name: `${headerRoute.type} ${headerRoute.source} header route`,
            fn: async (_req, res, params, _parsedUrl) => {
              const hasParams = Object.keys(params).length > 0

              for (const header of (headerRoute as Header).headers) {
                let { key, value } = header
                if (hasParams) {
                  key = compileNonPath(key, params)
                  value = compileNonPath(value, params)
                }
                res.setHeader(key, value)
              }
              return { finished: false }
            },
          } as Route
        })

    // since initial query values are decoded by querystring.parse
    // we need to re-encode them here but still allow passing through
    // values from rewrites/redirects
    const stringifyQuery = (req: IncomingMessage, query: ParsedUrlQuery) => {
      const initialQueryValues = Object.values(
        getRequestMeta(req, '__NEXT_INIT_QUERY') || {}
      )

      return stringifyQs(query, undefined, undefined, {
        encodeURIComponent(value) {
          if (initialQueryValues.some((val) => val === value)) {
            return encodeURIComponent(value)
          }
          return value
        },
      })
    }

    const proxyRequest = async (
      req: IncomingMessage,
      res: ServerResponse,
      parsedUrl: ParsedUrl
    ) => {
      const { query } = parsedUrl
      delete (parsedUrl as any).query
      parsedUrl.search = stringifyQuery(req, query)

      const target = formatUrl(parsedUrl)
      const proxy = new Proxy({
        target,
        changeOrigin: true,
        ignorePath: true,
        xfwd: true,
        proxyTimeout: 30_000, // limit proxying to 30 seconds
      })

      await new Promise((proxyResolve, proxyReject) => {
        let finished = false

        proxy.on('proxyReq', (proxyReq) => {
          proxyReq.on('close', () => {
            if (!finished) {
              finished = true
              proxyResolve(true)
            }
          })
        })
        proxy.on('error', (err) => {
          if (!finished) {
            finished = true
            proxyReject(err)
          }
        })
        proxy.web(req, res)
      })

      return {
        finished: true,
      }
    }

    const redirects = this.minimalMode
      ? []
      : this.customRoutes.redirects.map((redirect) => {
          const redirectRoute = getCustomRoute(redirect, 'redirect')
          return {
            internal: redirectRoute.internal,
            type: redirectRoute.type,
            match: redirectRoute.match,
            has: redirectRoute.has,
            statusCode: redirectRoute.statusCode,
            name: `Redirect route ${redirectRoute.source}`,
            fn: async (req, res, params, parsedUrl) => {
              const { parsedDestination } = prepareDestination({
                appendParamsToQuery: false,
                destination: redirectRoute.destination,
                params: params,
                query: parsedUrl.query,
              })

              const { query } = parsedDestination
              delete (parsedDestination as any).query

              parsedDestination.search = stringifyQuery(req, query)

              let updatedDestination = formatUrl(parsedDestination)

              if (updatedDestination.startsWith('/')) {
                updatedDestination =
                  normalizeRepeatedSlashes(updatedDestination)
              }

              res.setHeader('Location', updatedDestination)
              res.statusCode = getRedirectStatus(redirectRoute as Redirect)

              // Since IE11 doesn't support the 308 header add backwards
              // compatibility using refresh header
              if (res.statusCode === 308) {
                res.setHeader('Refresh', `0;url=${updatedDestination}`)
              }

              res.end(updatedDestination)
              return {
                finished: true,
              }
            },
          } as Route
        })

    const buildRewrite = (rewrite: Rewrite, check = true) => {
      const rewriteRoute = getCustomRoute(rewrite, 'rewrite')
      return {
        ...rewriteRoute,
        check,
        type: rewriteRoute.type,
        name: `Rewrite route ${rewriteRoute.source}`,
        match: rewriteRoute.match,
        fn: async (req, res, params, parsedUrl) => {
          const { newUrl, parsedDestination } = prepareDestination({
            appendParamsToQuery: true,
            destination: rewriteRoute.destination,
            params: params,
            query: parsedUrl.query,
          })

          // external rewrite, proxy it
          if (parsedDestination.protocol) {
            return proxyRequest(req, res, parsedDestination)
          }

          addRequestMeta(req, '_nextRewroteUrl', newUrl)
          addRequestMeta(req, '_nextDidRewrite', newUrl !== req.url)

          return {
            finished: false,
            pathname: newUrl,
            query: parsedDestination.query,
          }
        },
      } as Route
    }

    let beforeFiles: Route[] = []
    let afterFiles: Route[] = []
    let fallback: Route[] = []

    if (!this.minimalMode) {
      if (Array.isArray(this.customRoutes.rewrites)) {
        afterFiles = this.customRoutes.rewrites.map((r) => buildRewrite(r))
      } else {
        beforeFiles = this.customRoutes.rewrites.beforeFiles.map((r) =>
          buildRewrite(r, false)
        )
        afterFiles = this.customRoutes.rewrites.afterFiles.map((r) =>
          buildRewrite(r)
        )
        fallback = this.customRoutes.rewrites.fallback.map((r) =>
          buildRewrite(r)
        )
      }
    }

    let catchAllMiddleware: Route | undefined

    if (!this.minimalMode) {
      catchAllMiddleware = {
        match: route('/:path*'),
        type: 'route',
        name: 'middleware catchall',
        fn: async (req, res, _params, parsed) => {
          const fullUrl = getRequestMeta(req, '__NEXT_INIT_URL')
          const parsedUrl = parseNextUrl({
            url: fullUrl,
            headers: req.headers,
            nextConfig: {
              basePath: this.nextConfig.basePath,
              i18n: this.nextConfig.i18n,
              trailingSlash: this.nextConfig.trailingSlash,
            },
          })

          if (!this.middleware?.some((m) => m.match(parsedUrl.pathname))) {
            return { finished: false }
          }

          let result: FetchEventResult | null = null

          try {
            result = await this.runMiddleware({
              request: req,
              response: res,
              parsedUrl: parsedUrl,
              parsed: parsed,
            })
          } catch (err) {
            if (isError(err) && err.code === 'ENOENT') {
              await this.render404(req, res, parsed)
              return { finished: true }
            }

            const error = isError(err) ? err : new Error(err + '')
            console.error(error)
            res.statusCode = 500
            this.renderError(error, req, res, parsed.pathname || '')
            return { finished: true }
          }

          if (result === null) {
            return { finished: true }
          }

          if (
            !result.response.headers.has('x-middleware-rewrite') &&
            !result.response.headers.has('x-middleware-next') &&
            !result.response.headers.has('Location')
          ) {
            result.response.headers.set('x-middleware-refresh', '1')
          }

          result.response.headers.delete('x-middleware-next')

          for (const [key, value] of Object.entries(
            toNodeHeaders(result.response.headers)
          )) {
            if (key !== 'content-encoding' && value !== undefined) {
              res.setHeader(key, value)
            }
          }

          const preflight =
            req.method === 'HEAD' && req.headers['x-middleware-preflight']

          if (preflight) {
            res.writeHead(200)
            res.end()
            return {
              finished: true,
            }
          }

          res.statusCode = result.response.status
          res.statusMessage = result.response.statusText

          const location = result.response.headers.get('Location')
          if (location) {
            res.statusCode = result.response.status
            if (res.statusCode === 308) {
              res.setHeader('Refresh', `0;url=${location}`)
            }

            res.end()
            return {
              finished: true,
            }
          }

          if (result.response.headers.has('x-middleware-rewrite')) {
            const { newUrl, parsedDestination } = prepareDestination({
              appendParamsToQuery: true,
              destination: result.response.headers.get('x-middleware-rewrite')!,
              params: _params,
              query: parsedUrl.query,
            })

            if (
              parsedDestination.protocol &&
              (parsedDestination.port
                ? `${parsedDestination.hostname}:${parsedDestination.port}`
                : parsedDestination.hostname) !== req.headers.host
            ) {
              return proxyRequest(req, res, parsedDestination)
            }

            if (this.nextConfig.i18n) {
              const localePathResult = normalizeLocalePath(
                newUrl,
                this.nextConfig.i18n.locales
              )
              if (localePathResult.detectedLocale) {
                parsedDestination.query.__nextLocale =
                  localePathResult.detectedLocale
              }
            }

            addRequestMeta(req, '_nextRewroteUrl', newUrl)
            addRequestMeta(req, '_nextDidRewrite', newUrl !== req.url)

            return {
              finished: false,
              pathname: newUrl,
              query: parsedDestination.query,
            }
          }

          if (result.response.headers.has('x-middleware-refresh')) {
            res.writeHead(result.response.status)
            for await (const chunk of result.response.body || []) {
              res.write(chunk)
            }
            res.end()
            return {
              finished: true,
            }
          }

          return {
            finished: false,
          }
        },
      }
    }

    const catchAllRoute: Route = {
      match: route('/:path*'),
      type: 'route',
      name: 'Catchall render',
      fn: async (req, res, _params, parsedUrl) => {
        let { pathname, query } = parsedUrl
        if (!pathname) {
          throw new Error('pathname is undefined')
        }

        // next.js core assumes page path without trailing slash
        pathname = removePathTrailingSlash(pathname)

        if (this.nextConfig.i18n) {
          const localePathResult = normalizeLocalePath(
            pathname,
            this.nextConfig.i18n?.locales
          )

          if (localePathResult.detectedLocale) {
            pathname = localePathResult.pathname
            parsedUrl.query.__nextLocale = localePathResult.detectedLocale
          }
        }
        const bubbleNoFallback = !!query._nextBubbleNoFallback

        if (pathname.match(MIDDLEWARE_ROUTE)) {
          await this.render404(req, res, parsedUrl)
          return {
            finished: true,
          }
        }

        if (pathname === '/api' || pathname.startsWith('/api/')) {
          delete query._nextBubbleNoFallback

          const handled = await this.handleApiRequest(
            req as NextApiRequest,
            res as NextApiResponse,
            pathname,
            query
          )
          if (handled) {
            return { finished: true }
          }
        }

        try {
          await this.render(req, res, pathname, query, parsedUrl)

          return {
            finished: true,
          }
        } catch (err) {
          if (err instanceof NoFallbackError && bubbleNoFallback) {
            return {
              finished: false,
            }
          }
          throw err
        }
      },
    }

    const { useFileSystemPublicRoutes } = this.nextConfig

    if (useFileSystemPublicRoutes) {
      this.dynamicRoutes = this.getDynamicRoutes()
      if (!this.minimalMode) {
        this.middleware = this.getMiddleware()
      }
    }

    return {
      headers,
      fsRoutes,
      rewrites: {
        beforeFiles,
        afterFiles,
        fallback,
      },
      redirects,
      catchAllRoute,
      catchAllMiddleware,
      useFileSystemPublicRoutes,
      dynamicRoutes: this.dynamicRoutes,
      basePath: this.nextConfig.basePath,
      pageChecker: this.hasPage.bind(this),
      locales: this.nextConfig.i18n?.locales || [],
    }
  }

  private async getPagePath(
    pathname: string,
    locales?: string[]
  ): Promise<string> {
    return getPagePath(
      pathname,
      this.distDir,
      this._isLikeServerless,
      this.renderOpts.dev,
      locales
    )
  }

  protected async hasPage(pathname: string): Promise<boolean> {
    let found = false
    try {
      found = !!(await this.getPagePath(
        pathname,
        this.nextConfig.i18n?.locales
      ))
    } catch (_) {}

    return found
  }

  protected async _beforeCatchAllRender(
    _req: IncomingMessage,
    _res: ServerResponse,
    _params: Params,
    _parsedUrl: UrlWithParsedQuery
  ): Promise<boolean> {
    return false
  }

  // Used to build API page in development
  protected async ensureApiPage(_pathname: string): Promise<void> {}

  /**
   * Resolves `API` request, in development builds on demand
   * @param req http request
   * @param res http response
   * @param pathname path of request
   */
  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: ParsedUrlQuery
  ): Promise<boolean> {
    let page = pathname
    let params: Params | boolean = false
    let pageFound = await this.hasPage(page)

    if (!pageFound && this.dynamicRoutes) {
      for (const dynamicRoute of this.dynamicRoutes) {
        params = dynamicRoute.match(pathname)
        if (dynamicRoute.page.startsWith('/api') && params) {
          page = dynamicRoute.page
          pageFound = true
          break
        }
      }
    }

    if (!pageFound) {
      return false
    }
    // Make sure the page is built before getting the path
    // or else it won't be in the manifest yet
    await this.ensureApiPage(page)

    let builtPagePath
    try {
      builtPagePath = await this.getPagePath(page)
    } catch (err) {
      if (isError(err) && err.code === 'ENOENT') {
        return false
      }
      throw err
    }

    const pageModule = await require(builtPagePath)
    query = { ...query, ...params }

    delete query.__nextLocale
    delete query.__nextDefaultLocale

    if (!this.renderOpts.dev && this._isLikeServerless) {
      if (typeof pageModule.default === 'function') {
        prepareServerlessUrl(req, query)
        await pageModule.default(req, res)
        return true
      }
    }

    await apiResolver(
      req,
      res,
      query,
      pageModule,
      this.renderOpts.previewProps,
      this.minimalMode,
      this.renderOpts.dev,
      page
    )
    return true
  }

  protected generatePublicRoutes(): Route[] {
    const publicFiles = new Set(
      recursiveReadDirSync(this.publicDir).map((p) =>
        encodeURI(p.replace(/\\/g, '/'))
      )
    )

    return [
      {
        match: route('/:path*'),
        name: 'public folder catchall',
        fn: async (req, res, params, parsedUrl) => {
          const pathParts: string[] = params.path || []
          const { basePath } = this.nextConfig

          // if basePath is defined require it be present
          if (basePath) {
            const basePathParts = basePath.split('/')
            // remove first empty value
            basePathParts.shift()

            if (
              !basePathParts.every((part: string, idx: number) => {
                return part === pathParts[idx]
              })
            ) {
              return { finished: false }
            }

            pathParts.splice(0, basePathParts.length)
          }

          let path = `/${pathParts.join('/')}`

          if (!publicFiles.has(path)) {
            // In `next-dev-server.ts`, we ensure encoded paths match
            // decoded paths on the filesystem. So we need do the
            // opposite here: make sure decoded paths match encoded.
            path = encodeURI(path)
          }

          if (publicFiles.has(path)) {
            await this.serveStatic(
              req,
              res,
              join(this.publicDir, ...pathParts),
              parsedUrl
            )
            return {
              finished: true,
            }
          }
          return {
            finished: false,
          }
        },
      } as Route,
    ]
  }

  protected getDynamicRoutes(): Array<RoutingItem> {
    const addedPages = new Set<string>()

    return getSortedRoutes(
      Object.keys(this.pagesManifest!).map(
        (page) =>
          normalizeLocalePath(page, this.nextConfig.i18n?.locales).pathname
      )
    )
      .map((page) => {
        if (addedPages.has(page) || !isDynamicRoute(page)) return null
        addedPages.add(page)
        return {
          page,
          match: getRouteMatcher(getRouteRegex(page)),
        }
      })
      .filter((item): item is RoutingItem => Boolean(item))
  }

  private handleCompression(req: IncomingMessage, res: ServerResponse): void {
    if (this.compression) {
      this.compression(req, res, () => {})
    }
  }

  protected async run(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: UrlWithParsedQuery
  ): Promise<void> {
    this.handleCompression(req, res)

    try {
      const matched = await this.router.execute(req, res, parsedUrl)
      if (matched) {
        return
      }
    } catch (err) {
      if (err instanceof DecodeError) {
        res.statusCode = 400
        return this.renderError(null, req, res, '/_error', {})
      }
      throw err
    }

    await this.render404(req, res, parsedUrl)
  }

  private async pipe(
    fn: (ctx: RequestContext) => Promise<ResponsePayload | null>,
    partialContext: {
      req: IncomingMessage
      res: ServerResponse
      pathname: string
      query: NextParsedUrlQuery
    }
  ): Promise<void> {
    const userAgent = partialContext.req.headers['user-agent']
    const ctx = {
      ...partialContext,
      renderOpts: {
        ...this.renderOpts,
        supportsDynamicHTML: userAgent ? !isBot(userAgent) : false,
      },
    } as const
    const payload = await fn(ctx)
    if (payload === null) {
      return
    }
    const { req, res } = ctx
    const { body, type, revalidateOptions } = payload
    if (!isResSent(res)) {
      const { generateEtags, poweredByHeader, dev } = this.renderOpts
      if (dev) {
        // In dev, we should not cache pages for any reason.
        res.setHeader('Cache-Control', 'no-store, must-revalidate')
      }
      return sendRenderResult({
        req,
        res,
        result: body,
        type,
        generateEtags,
        poweredByHeader,
        options: revalidateOptions,
      })
    }
  }

  private async getStaticHTML(
    fn: (ctx: RequestContext) => Promise<ResponsePayload | null>,
    partialContext: {
      req: IncomingMessage
      res: ServerResponse
      pathname: string
      query: ParsedUrlQuery
    }
  ): Promise<string | null> {
    const payload = await fn({
      ...partialContext,
      renderOpts: {
        ...this.renderOpts,
        supportsDynamicHTML: false,
      },
    })
    if (payload === null) {
      return null
    }
    return payload.body.toUnchunkedString()
  }

  public async render(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: NextParsedUrlQuery = {},
    parsedUrl?: NextUrlWithParsedQuery
  ): Promise<void> {
    if (!pathname.startsWith('/')) {
      console.warn(
        `Cannot render page with path "${pathname}", did you mean "/${pathname}"?. See more info here: https://nextjs.org/docs/messages/render-no-starting-slash`
      )
    }

    if (
      this.renderOpts.customServer &&
      pathname === '/index' &&
      !(await this.hasPage('/index'))
    ) {
      // maintain backwards compatibility for custom server
      // (see custom-server integration tests)
      pathname = '/'
    }

    // we allow custom servers to call render for all URLs
    // so check if we need to serve a static _next file or not.
    // we don't modify the URL for _next/data request but still
    // call render so we special case this to prevent an infinite loop
    if (
      !this.minimalMode &&
      !query._nextDataReq &&
      (req.url?.match(/^\/_next\//) ||
        (this.hasStaticDir && req.url!.match(/^\/static\//)))
    ) {
      return this.handleRequest(req, res, parsedUrl)
    }

    // Custom server users can run `app.render()` which needs compression.
    if (this.renderOpts.customServer) {
      this.handleCompression(req, res)
    }

    if (isBlockedPage(pathname)) {
      return this.render404(req, res, parsedUrl)
    }

    return this.pipe((ctx) => this.renderToResponse(ctx), {
      req,
      res,
      pathname,
      query,
    })
  }

  protected async findPageComponents(
    pathname: string,
    query: NextParsedUrlQuery = {},
    params: Params | null = null
  ): Promise<FindComponentsResult | null> {
    let paths = [
      // try serving a static AMP version first
      query.amp ? normalizePagePath(pathname) + '.amp' : null,
      pathname,
    ].filter(Boolean)

    if (query.__nextLocale) {
      paths = [
        ...paths.map(
          (path) => `/${query.__nextLocale}${path === '/' ? '' : path}`
        ),
        ...paths,
      ]
    }

    for (const pagePath of paths) {
      try {
        const components = await loadComponents(
          this.distDir,
          pagePath!,
          !this.renderOpts.dev && this._isLikeServerless
        )

        if (
          query.__nextLocale &&
          typeof components.Component === 'string' &&
          !pagePath?.startsWith(`/${query.__nextLocale}`)
        ) {
          // if loading an static HTML file the locale is required
          // to be present since all HTML files are output under their locale
          continue
        }

        return {
          components,
          query: {
            ...(components.getStaticProps
              ? ({
                  amp: query.amp,
                  _nextDataReq: query._nextDataReq,
                  __nextLocale: query.__nextLocale,
                  __nextDefaultLocale: query.__nextDefaultLocale,
                } as NextParsedUrlQuery)
              : query),
            ...(params || {}),
          },
        }
      } catch (err) {
        if (isError(err) && err.code !== 'ENOENT') throw err
      }
    }
    return null
  }

  protected async getStaticPaths(pathname: string): Promise<{
    staticPaths: string[] | undefined
    fallbackMode: 'static' | 'blocking' | false
  }> {
    // `staticPaths` is intentionally set to `undefined` as it should've
    // been caught when checking disk data.
    const staticPaths = undefined

    // Read whether or not fallback should exist from the manifest.
    const fallbackField =
      this.getPrerenderManifest().dynamicRoutes[pathname].fallback

    return {
      staticPaths,
      fallbackMode:
        typeof fallbackField === 'string'
          ? 'static'
          : fallbackField === null
          ? 'blocking'
          : false,
    }
  }

  private async renderToResponseWithComponents(
    { req, res, pathname, renderOpts: opts }: RequestContext,
    { components, query }: FindComponentsResult
  ): Promise<ResponsePayload | null> {
    const is404Page = pathname === '/404'
    const is500Page = pathname === '/500'

    const isLikeServerless =
      typeof components.ComponentMod === 'object' &&
      typeof (components.ComponentMod as any).renderReqToHTML === 'function'
    const isSSG = !!components.getStaticProps
    const hasServerProps = !!components.getServerSideProps
    const hasStaticPaths = !!components.getStaticPaths
    const hasGetInitialProps = !!(components.Component as any).getInitialProps

    // Toggle whether or not this is a Data request
    const isDataReq = !!query._nextDataReq && (isSSG || hasServerProps)
    delete query._nextDataReq

    // we need to ensure the status code if /404 is visited directly
    if (is404Page && !isDataReq) {
      res.statusCode = 404
    }

    // ensure correct status is set when visiting a status page
    // directly e.g. /500
    if (STATIC_STATUS_PAGES.includes(pathname)) {
      res.statusCode = parseInt(pathname.substr(1), 10)
    }

    // handle static page
    if (typeof components.Component === 'string') {
      return {
        type: 'html',
        // TODO: Static pages should be serialized as RenderResult
        body: RenderResult.fromStatic(components.Component),
      }
    }

    if (!query.amp) {
      delete query.amp
    }

    if (opts.supportsDynamicHTML === true) {
      // Disable dynamic HTML in cases that we know it won't be generated,
      // so that we can continue generating a cache key when possible.
      opts.supportsDynamicHTML =
        !isSSG &&
        !isLikeServerless &&
        !query.amp &&
        !this.minimalMode &&
        typeof components.Document?.getInitialProps !== 'function'
    }

    const defaultLocale = isSSG
      ? this.nextConfig.i18n?.defaultLocale
      : query.__nextDefaultLocale

    const locale = query.__nextLocale
    const locales = this.nextConfig.i18n?.locales

    let previewData: PreviewData
    let isPreviewMode = false

    if (hasServerProps || isSSG) {
      previewData = tryGetPreviewData(req, res, this.renderOpts.previewProps)
      isPreviewMode = previewData !== false
    }

    // Compute the iSSG cache key. We use the rewroteUrl since
    // pages with fallback: false are allowed to be rewritten to
    // and we need to look up the path by the rewritten path
    let urlPathname = parseUrl(req.url || '').pathname || '/'

    let resolvedUrlPathname =
      getRequestMeta(req, '_nextRewroteUrl') || urlPathname

    urlPathname = removePathTrailingSlash(urlPathname)
    resolvedUrlPathname = normalizeLocalePath(
      removePathTrailingSlash(resolvedUrlPathname),
      this.nextConfig.i18n?.locales
    ).pathname

    const stripNextDataPath = (path: string) => {
      if (path.includes(this.buildId)) {
        const splitPath = path.substring(
          path.indexOf(this.buildId) + this.buildId.length
        )

        path = denormalizePagePath(splitPath.replace(/\.json$/, ''))
      }

      if (this.nextConfig.i18n) {
        return normalizeLocalePath(path, locales).pathname
      }
      return path
    }

    const handleRedirect = (pageData: any) => {
      const redirect = {
        destination: pageData.pageProps.__N_REDIRECT,
        statusCode: pageData.pageProps.__N_REDIRECT_STATUS,
        basePath: pageData.pageProps.__N_REDIRECT_BASE_PATH,
      }
      const statusCode = getRedirectStatus(redirect)
      const { basePath } = this.nextConfig

      if (
        basePath &&
        redirect.basePath !== false &&
        redirect.destination.startsWith('/')
      ) {
        redirect.destination = `${basePath}${redirect.destination}`
      }

      if (redirect.destination.startsWith('/')) {
        redirect.destination = normalizeRepeatedSlashes(redirect.destination)
      }

      if (statusCode === PERMANENT_REDIRECT_STATUS) {
        res.setHeader('Refresh', `0;url=${redirect.destination}`)
      }

      res.statusCode = statusCode
      res.setHeader('Location', redirect.destination)
      res.end()
    }

    // remove /_next/data prefix from urlPathname so it matches
    // for direct page visit and /_next/data visit
    if (isDataReq) {
      resolvedUrlPathname = stripNextDataPath(resolvedUrlPathname)
      urlPathname = stripNextDataPath(urlPathname)
    }

    let ssgCacheKey =
      isPreviewMode || !isSSG || this.minimalMode || opts.supportsDynamicHTML
        ? null // Preview mode bypasses the cache
        : `${locale ? `/${locale}` : ''}${
            (pathname === '/' || resolvedUrlPathname === '/') && locale
              ? ''
              : resolvedUrlPathname
          }${query.amp ? '.amp' : ''}`

    if ((is404Page || is500Page) && isSSG) {
      ssgCacheKey = `${locale ? `/${locale}` : ''}${pathname}${
        query.amp ? '.amp' : ''
      }`
    }

    if (ssgCacheKey) {
      // we only encode path delimiters for path segments from
      // getStaticPaths so we need to attempt decoding the URL
      // to match against and only escape the path delimiters
      // this allows non-ascii values to be handled e.g. Japanese characters

      // TODO: investigate adding this handling for non-SSG pages so
      // non-ascii names work there also
      ssgCacheKey = ssgCacheKey
        .split('/')
        .map((seg) => {
          try {
            seg = escapePathDelimiters(decodeURIComponent(seg), true)
          } catch (_) {
            // An improperly encoded URL was provided
            throw new DecodeError('failed to decode param')
          }
          return seg
        })
        .join('/')
    }

    const doRender: () => Promise<ResponseCacheEntry | null> = async () => {
      let pageData: any
      let body: RenderResult | null
      let sprRevalidate: number | false
      let isNotFound: boolean | undefined
      let isRedirect: boolean | undefined

      // handle serverless
      if (isLikeServerless) {
        const renderResult = await (
          components.ComponentMod as any
        ).renderReqToHTML(req, res, 'passthrough', {
          locale,
          locales,
          defaultLocale,
          optimizeCss: this.renderOpts.optimizeCss,
          distDir: this.distDir,
          fontManifest: this.renderOpts.fontManifest,
          domainLocales: this.renderOpts.domainLocales,
        })

        body = renderResult.html
        pageData = renderResult.renderOpts.pageData
        sprRevalidate = renderResult.renderOpts.revalidate
        isNotFound = renderResult.renderOpts.isNotFound
        isRedirect = renderResult.renderOpts.isRedirect
      } else {
        const origQuery = parseUrl(req.url || '', true).query
        const hadTrailingSlash =
          urlPathname !== '/' && this.nextConfig.trailingSlash

        const resolvedUrl = formatUrl({
          pathname: `${resolvedUrlPathname}${hadTrailingSlash ? '/' : ''}`,
          // make sure to only add query values from original URL
          query: origQuery,
        })

        const renderOpts: RenderOpts = {
          ...components,
          ...opts,
          isDataReq,
          resolvedUrl,
          locale,
          locales,
          defaultLocale,
          // For getServerSideProps and getInitialProps we need to ensure we use the original URL
          // and not the resolved URL to prevent a hydration mismatch on
          // asPath
          resolvedAsPath:
            hasServerProps || hasGetInitialProps
              ? formatUrl({
                  // we use the original URL pathname less the _next/data prefix if
                  // present
                  pathname: `${urlPathname}${hadTrailingSlash ? '/' : ''}`,
                  query: origQuery,
                })
              : resolvedUrl,
        }

        const renderResult = await renderToHTML(
          req,
          res,
          pathname,
          query,
          renderOpts
        )

        body = renderResult
        // TODO: change this to a different passing mechanism
        pageData = (renderOpts as any).pageData
        sprRevalidate = (renderOpts as any).revalidate
        isNotFound = (renderOpts as any).isNotFound
        isRedirect = (renderOpts as any).isRedirect
      }

      let value: ResponseCacheValue | null
      if (isNotFound) {
        value = null
      } else if (isRedirect) {
        value = { kind: 'REDIRECT', props: pageData }
      } else {
        if (!body) {
          return null
        }
        value = { kind: 'PAGE', html: body, pageData }
      }
      return { revalidate: sprRevalidate, value }
    }

    const cacheEntry = await this.responseCache.get(
      ssgCacheKey,
      async (hasResolved) => {
        const isProduction = !this.renderOpts.dev
        const isDynamicPathname = isDynamicRoute(pathname)
        const didRespond = hasResolved || isResSent(res)

        let { staticPaths, fallbackMode } = hasStaticPaths
          ? await this.getStaticPaths(pathname)
          : { staticPaths: undefined, fallbackMode: false }

        if (
          fallbackMode === 'static' &&
          isBot(req.headers['user-agent'] || '')
        ) {
          fallbackMode = 'blocking'
        }

        // When we did not respond from cache, we need to choose to block on
        // rendering or return a skeleton.
        //
        // * Data requests always block.
        //
        // * Blocking mode fallback always blocks.
        //
        // * Preview mode toggles all pages to be resolved in a blocking manner.
        //
        // * Non-dynamic pages should block (though this is an impossible
        //   case in production).
        //
        // * Dynamic pages should return their skeleton if not defined in
        //   getStaticPaths, then finish the data request on the client-side.
        //
        if (
          this.minimalMode !== true &&
          fallbackMode !== 'blocking' &&
          ssgCacheKey &&
          !didRespond &&
          !isPreviewMode &&
          isDynamicPathname &&
          // Development should trigger fallback when the path is not in
          // `getStaticPaths`
          (isProduction ||
            !staticPaths ||
            !staticPaths.includes(
              // we use ssgCacheKey here as it is normalized to match the
              // encoding from getStaticPaths along with including the locale
              query.amp ? ssgCacheKey.replace(/\.amp$/, '') : ssgCacheKey
            ))
        ) {
          if (
            // In development, fall through to render to handle missing
            // getStaticPaths.
            (isProduction || staticPaths) &&
            // When fallback isn't present, abort this render so we 404
            fallbackMode !== 'static'
          ) {
            throw new NoFallbackError()
          }

          if (!isDataReq) {
            // Production already emitted the fallback as static HTML.
            if (isProduction) {
              const html = await this.incrementalCache.getFallback(
                locale ? `/${locale}${pathname}` : pathname
              )
              return {
                value: {
                  kind: 'PAGE',
                  html: RenderResult.fromStatic(html),
                  pageData: {},
                },
              }
            }
            // We need to generate the fallback on-demand for development.
            else {
              query.__nextFallback = 'true'
              if (isLikeServerless) {
                prepareServerlessUrl(req, query)
              }
              const result = await doRender()
              if (!result) {
                return null
              }
              // Prevent caching this result
              delete result.revalidate
              return result
            }
          }
        }

        const result = await doRender()
        if (!result) {
          return null
        }
        return {
          ...result,
          revalidate:
            result.revalidate !== undefined
              ? result.revalidate
              : /* default to minimum revalidate (this should be an invariant) */ 1,
        }
      }
    )

    if (!cacheEntry) {
      if (ssgCacheKey) {
        // A cache entry might not be generated if a response is written
        // in `getInitialProps` or `getServerSideProps`, but those shouldn't
        // have a cache key. If we do have a cache key but we don't end up
        // with a cache entry, then either Next.js or the application has a
        // bug that needs fixing.
        throw new Error('invariant: cache entry required but not generated')
      }
      return null
    }

    const { revalidate, value: cachedData } = cacheEntry
    const revalidateOptions: any =
      typeof revalidate !== 'undefined' &&
      (!this.renderOpts.dev || (hasServerProps && !isDataReq))
        ? {
            // When the page is 404 cache-control should not be added unless
            // we are rendering the 404 page for notFound: true which should
            // cache according to revalidate correctly
            private: isPreviewMode || (is404Page && cachedData),
            stateful: !isSSG,
            revalidate,
          }
        : undefined

    if (!cachedData) {
      if (revalidateOptions) {
        setRevalidateHeaders(res, revalidateOptions)
      }
      if (isDataReq) {
        res.statusCode = 404
        res.end('{"notFound":true}')
        return null
      } else {
        await this.render404(
          req,
          res,
          {
            pathname,
            query,
          } as UrlWithParsedQuery,
          false
        )
        return null
      }
    } else if (cachedData.kind === 'REDIRECT') {
      if (isDataReq) {
        return {
          type: 'json',
          body: RenderResult.fromStatic(JSON.stringify(cachedData.props)),
          revalidateOptions,
        }
      } else {
        await handleRedirect(cachedData.props)
        return null
      }
    } else {
      return {
        type: isDataReq ? 'json' : 'html',
        body: isDataReq
          ? RenderResult.fromStatic(JSON.stringify(cachedData.pageData))
          : cachedData.html,
        revalidateOptions,
      }
    }
  }

  private async renderToResponse(
    ctx: RequestContext
  ): Promise<ResponsePayload | null> {
    const { res, query, pathname } = ctx
    let page = pathname
    const bubbleNoFallback = !!query._nextBubbleNoFallback
    delete query._nextBubbleNoFallback

    try {
      const result = await this.findPageComponents(pathname, query)
      if (result) {
        try {
          return await this.renderToResponseWithComponents(ctx, result)
        } catch (err) {
          const isNoFallbackError = err instanceof NoFallbackError

          if (!isNoFallbackError || (isNoFallbackError && bubbleNoFallback)) {
            throw err
          }
        }
      }

      if (this.dynamicRoutes) {
        for (const dynamicRoute of this.dynamicRoutes) {
          const params = dynamicRoute.match(pathname)
          if (!params) {
            continue
          }

          const dynamicRouteResult = await this.findPageComponents(
            dynamicRoute.page,
            query,
            params
          )
          if (dynamicRouteResult) {
            try {
              page = dynamicRoute.page
              return await this.renderToResponseWithComponents(
                {
                  ...ctx,
                  pathname: dynamicRoute.page,
                  renderOpts: {
                    ...ctx.renderOpts,
                    params,
                  },
                },
                dynamicRouteResult
              )
            } catch (err) {
              const isNoFallbackError = err instanceof NoFallbackError

              if (
                !isNoFallbackError ||
                (isNoFallbackError && bubbleNoFallback)
              ) {
                throw err
              }
            }
          }
        }
      }
    } catch (error) {
      const err = isError(error) ? error : error ? new Error(error + '') : null
      if (err instanceof NoFallbackError && bubbleNoFallback) {
        throw err
      }
      if (err instanceof DecodeError) {
        res.statusCode = 400
        return await this.renderErrorToResponse(ctx, err)
      }

      res.statusCode = 500
      const isWrappedError = err instanceof WrappedBuildError
      const response = await this.renderErrorToResponse(
        ctx,
        isWrappedError ? (err as WrappedBuildError).innerError : err
      )

      if (!isWrappedError) {
        if (this.minimalMode || this.renderOpts.dev) {
          if (isError(err)) err.page = page
          throw err
        }
        this.logError(err || new Error(error + ''))
      }
      return response
    }
    res.statusCode = 404
    return this.renderErrorToResponse(ctx, null)
  }

  public async renderToHTML(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: ParsedUrlQuery = {}
  ): Promise<string | null> {
    return this.getStaticHTML((ctx) => this.renderToResponse(ctx), {
      req,
      res,
      pathname,
      query,
    })
  }

  public async renderError(
    err: Error | null,
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: NextParsedUrlQuery = {},
    setHeaders = true
  ): Promise<void> {
    if (setHeaders) {
      res.setHeader(
        'Cache-Control',
        'no-cache, no-store, max-age=0, must-revalidate'
      )
    }

    return this.pipe(
      async (ctx) => {
        const response = await this.renderErrorToResponse(ctx, err)
        if (this.minimalMode && res.statusCode === 500) {
          throw err
        }
        return response
      },
      { req, res, pathname, query }
    )
  }

  private customErrorNo404Warn = execOnce(() => {
    Log.warn(
      `You have added a custom /_error page without a custom /404 page. This prevents the 404 page from being auto statically optimized.\nSee here for info: https://nextjs.org/docs/messages/custom-error-no-custom-404`
    )
  })

  private async renderErrorToResponse(
    ctx: RequestContext,
    _err: Error | null
  ): Promise<ResponsePayload | null> {
    const { res, query } = ctx
    let err = _err
    if (this.renderOpts.dev && !err && res.statusCode === 500) {
      err = new Error(
        'An undefined error was thrown sometime during render... ' +
          'See https://nextjs.org/docs/messages/threw-undefined'
      )
    }
    try {
      let result: null | FindComponentsResult = null

      const is404 = res.statusCode === 404
      let using404Page = false

      // use static 404 page if available and is 404 response
      if (is404) {
        result = await this.findPageComponents('/404', query)
        using404Page = result !== null
      }
      let statusPage = `/${res.statusCode}`

      if (!result && STATIC_STATUS_PAGES.includes(statusPage)) {
        result = await this.findPageComponents(statusPage, query)
      }

      if (!result) {
        result = await this.findPageComponents('/_error', query)
        statusPage = '/_error'
      }

      if (
        process.env.NODE_ENV !== 'production' &&
        !using404Page &&
        (await this.hasPage('/_error')) &&
        !(await this.hasPage('/404'))
      ) {
        this.customErrorNo404Warn()
      }

      try {
        return await this.renderToResponseWithComponents(
          {
            ...ctx,
            pathname: statusPage,
            renderOpts: {
              ...ctx.renderOpts,
              err,
            },
          },
          result!
        )
      } catch (maybeFallbackError) {
        if (maybeFallbackError instanceof NoFallbackError) {
          throw new Error('invariant: failed to render error page')
        }
        throw maybeFallbackError
      }
    } catch (error) {
      const renderToHtmlError = isError(error)
        ? error
        : error
        ? new Error(error + '')
        : null
      const isWrappedError = renderToHtmlError instanceof WrappedBuildError
      if (!isWrappedError) {
        this.logError(renderToHtmlError || new Error(error + ''))
      }
      res.statusCode = 500
      const fallbackComponents = await this.getFallbackErrorComponents()

      if (fallbackComponents) {
        return this.renderToResponseWithComponents(
          {
            ...ctx,
            pathname: '/_error',
            renderOpts: {
              ...ctx.renderOpts,
              // We render `renderToHtmlError` here because `err` is
              // already captured in the stacktrace.
              err: isWrappedError
                ? renderToHtmlError.innerError
                : renderToHtmlError,
            },
          },
          {
            query,
            components: fallbackComponents,
          }
        )
      }
      return {
        type: 'html',
        body: RenderResult.fromStatic('Internal Server Error'),
      }
    }
  }

  public async renderErrorToHTML(
    err: Error | null,
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: ParsedUrlQuery = {}
  ): Promise<string | null> {
    return this.getStaticHTML((ctx) => this.renderErrorToResponse(ctx, err), {
      req,
      res,
      pathname,
      query,
    })
  }

  protected async getFallbackErrorComponents(): Promise<LoadComponentsReturnType | null> {
    // The development server will provide an implementation for this
    return null
  }

  public async render404(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl?: NextUrlWithParsedQuery,
    setHeaders = true
  ): Promise<void> {
    const { pathname, query }: NextUrlWithParsedQuery = parsedUrl
      ? parsedUrl
      : parseUrl(req.url!, true)

    if (this.nextConfig.i18n) {
      query.__nextLocale =
        query.__nextLocale || this.nextConfig.i18n.defaultLocale
      query.__nextDefaultLocale =
        query.__nextDefaultLocale || this.nextConfig.i18n.defaultLocale
    }

    res.statusCode = 404
    return this.renderError(null, req, res, pathname!, query, setHeaders)
  }

  public async serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    parsedUrl?: UrlWithParsedQuery
  ): Promise<void> {
    if (!this.isServeableUrl(path)) {
      return this.render404(req, res, parsedUrl)
    }

    if (!(req.method === 'GET' || req.method === 'HEAD')) {
      res.statusCode = 405
      res.setHeader('Allow', ['GET', 'HEAD'])
      return this.renderError(null, req, res, path)
    }

    try {
      await serveStatic(req, res, path)
    } catch (error) {
      if (!isError(error)) throw error
      const err = error as Error & { code?: string; statusCode?: number }
      if (err.code === 'ENOENT' || err.statusCode === 404) {
        this.render404(req, res, parsedUrl)
      } else if (err.statusCode === 412) {
        res.statusCode = 412
        return this.renderError(err, req, res, path)
      } else {
        throw err
      }
    }
  }

  private _validFilesystemPathSet: Set<string> | null = null
  private getFilesystemPaths(): Set<string> {
    if (this._validFilesystemPathSet) {
      return this._validFilesystemPathSet
    }

    const pathUserFilesStatic = join(this.dir, 'static')
    let userFilesStatic: string[] = []
    if (this.hasStaticDir && fs.existsSync(pathUserFilesStatic)) {
      userFilesStatic = recursiveReadDirSync(pathUserFilesStatic).map((f) =>
        join('.', 'static', f)
      )
    }

    let userFilesPublic: string[] = []
    if (this.publicDir && fs.existsSync(this.publicDir)) {
      userFilesPublic = recursiveReadDirSync(this.publicDir).map((f) =>
        join('.', 'public', f)
      )
    }

    let nextFilesStatic: string[] = []

    nextFilesStatic =
      !this.minimalMode && fs.existsSync(join(this.distDir, 'static'))
        ? recursiveReadDirSync(join(this.distDir, 'static')).map((f) =>
            join('.', relative(this.dir, this.distDir), 'static', f)
          )
        : []

    return (this._validFilesystemPathSet = new Set<string>([
      ...nextFilesStatic,
      ...userFilesPublic,
      ...userFilesStatic,
    ]))
  }

  protected isServeableUrl(untrustedFileUrl: string): boolean {
    // This method mimics what the version of `send` we use does:
    // 1. decodeURIComponent:
    //    https://github.com/pillarjs/send/blob/0.17.1/index.js#L989
    //    https://github.com/pillarjs/send/blob/0.17.1/index.js#L518-L522
    // 2. resolve:
    //    https://github.com/pillarjs/send/blob/de073ed3237ade9ff71c61673a34474b30e5d45b/index.js#L561

    let decodedUntrustedFilePath: string
    try {
      // (1) Decode the URL so we have the proper file name
      decodedUntrustedFilePath = decodeURIComponent(untrustedFileUrl)
    } catch {
      return false
    }

    // (2) Resolve "up paths" to determine real request
    const untrustedFilePath = resolve(decodedUntrustedFilePath)

    // don't allow null bytes anywhere in the file path
    if (untrustedFilePath.indexOf('\0') !== -1) {
      return false
    }

    // Check if .next/static, static and public are in the path.
    // If not the path is not available.
    if (
      (untrustedFilePath.startsWith(join(this.distDir, 'static') + sep) ||
        untrustedFilePath.startsWith(join(this.dir, 'static') + sep) ||
        untrustedFilePath.startsWith(join(this.dir, 'public') + sep)) === false
    ) {
      return false
    }

    // Check against the real filesystem paths
    const filesystemUrls = this.getFilesystemPaths()
    const resolved = relative(this.dir, untrustedFilePath)
    return filesystemUrls.has(resolved)
  }

  protected readBuildId(): string {
    const buildIdFile = join(this.distDir, BUILD_ID_FILE)
    try {
      return fs.readFileSync(buildIdFile, 'utf8').trim()
    } catch (err) {
      if (!fs.existsSync(buildIdFile)) {
        throw new Error(
          `Could not find a production build in the '${this.distDir}' directory. Try building your app with 'next build' before starting the production server. https://nextjs.org/docs/messages/production-start-no-build-id`
        )
      }

      throw err
    }
  }

  protected get _isLikeServerless(): boolean {
    return isTargetLikeServerless(this.nextConfig.target)
  }
}

function prepareServerlessUrl(
  req: IncomingMessage,
  query: ParsedUrlQuery
): void {
  const curUrl = parseUrl(req.url!, true)
  req.url = formatUrl({
    ...curUrl,
    search: undefined,
    query: {
      ...curUrl.query,
      ...query,
    },
  })
}

class NoFallbackError extends Error {}

// Internal wrapper around build errors at development
// time, to prevent us from propagating or logging them
export class WrappedBuildError extends Error {
  innerError: Error

  constructor(innerError: Error) {
    super()
    this.innerError = innerError
  }
}

type ResponsePayload = {
  type: 'html' | 'json'
  body: RenderResult
  revalidateOptions?: any
}
