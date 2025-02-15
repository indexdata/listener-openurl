// Creates an OpenURL server that contains a configured Koa app.
const compose = require('koa-compose');
const Koa = require('koa');
const KoaStatic = require('koa-static');
const { get, omit, find } = require('lodash');
const { ContextObject } = require('./ContextObject');
const { ReshareRequest } = require('./ReshareRequest');
const { OkapiSession } = require('./OkapiSession');
const idTransform = require('./idTransform');


async function parseRequest(ctx, next) {
  ctx.cfg.log('flow', 'Parse request');

  const co = new ContextObject(ctx.cfg, ctx.query);
  ctx.cfg.log('co', `got ContextObject ${co.getType()} query`, JSON.stringify(co.getQuery()));

  const metadata = co.getMetadata();
  ctx.cfg.log('metadata', JSON.stringify(metadata));

  ctx.cfg.log('flow', 'Check service');
  // service can come from path OR parameter
  const symbol = get(metadata, ['res', 'org']) || ctx.path.replace(/^\//, '');
  const service = ctx.services[symbol] || ctx.services[''];
  if (!service) ctx.throw(404, `unsupported service '${symbol}'`);

  const svcCfg = ctx.cfg.getServiceValues(symbol);
  if (svcCfg.reqIdHeader) {
    let fromHeader = ctx.req.headers?.[svcCfg?.reqIdHeader];
    if (typeof fromHeader === 'string') {
      fromHeader = idTransform(fromHeader, svcCfg);
      ctx.cfg.log('flow', `Override requester id with ${fromHeader}`);
      co.setAdmindata('req', 'id', fromHeader);
    }
  }

  const admindata = co.getAdmindata();
  ctx.cfg.log('admindata', JSON.stringify(admindata));

  const logout = get(metadata, ['svc', 'logout']);
  if (logout === '1') {
    // Allows us to force a re-login
    service.token = undefined;
  } else if (logout) {
    service.token = 'bad token';
  }

  const npl = svcCfg.digitalOnly || get(metadata, ['svc', 'noPickupLocation']);

  Object.assign(ctx.state, { admindata, co, metadata, npl, service, svcCfg, symbol });
  await next();
}

async function maybeRenderForm(ctx, next) {
  const { co, metadata, service, npl } = ctx.state;

  ctx.cfg.log('flow', 'Check metadata to determine if we should render form');
  if (!co.hasBasicData() || typeof ctx.query?.confirm !== 'undefined' || (!npl && !get(metadata, ['svc', 'pickupLocation']))) {
    ctx.cfg.log('flow', 'Rendering form');
    if (!npl) await service.getPickupLocations();

    const query = Object.assign({}, co.getQuery());
    delete query.confirm;
    const ntries = query['svc.ntries'] || 0;
    query['svc.ntries'] = ntries + 1;

    let formName;
    const formFields = ['svc.pickupLocation', 'rft.volume', 'svc.note'];
    if (co.hasBasicData()) {
      formName = 'form2';
      formFields.push('svc.neededBy'); // XXX Should this also be in form1?
    } else {
      formName = 'form1';
      formFields.push('rft.title', 'rft.au', 'rft.date', 'rft.pub', 'rft.place', 'rft.edition', 'rft.isbn', 'rft.oclc');
    }

    if (!query['rft.title']) {
      query['rft.title'] = query['rft.btitle'] || query['rft.atitle'] || query['rft.jtitle'];
    }
    if (!query['rft.au']) {
      query['rft.au'] = query['rft.creator'] || query['rft.aulast'] || query['rft.aufirst'];
    }

    const allValues = Object.keys(omit(query, formFields))
      .sort()
      .map(key => `<input type="hidden" name="${key}" value="${query[key]}" />`)
      .join('\n');

    const data = Object.assign({}, query, {
      allValues,
      digitalOnly: ctx.state?.svcCfg?.digitalOnly,
      noPickupLocation: ntries > 0 && !query['svc.pickupLocation'] && !ctx.state?.svcCfg?.digitalOnly,
      onePickupLocation: (service?.pickupLocations?.length === 1),
      pickupLocations: (service.pickupLocations || []).map(x => ({
        id: x.id,
        code: x.code,
        name: x.name,
        selected: x.id === query['svc.pickupLocation'] ? 'selected' : '',
      })),
    });

    const template = ctx.cfg.getTemplate(formName);
    ctx.body = template(data);
  } else {
    await next();
  }
}

async function maybeReturnAdminData(ctx, next) {
  const { admindata, metadata } = ctx.state;
  if (admindata.svc?.id === 'contextObject') {
    ctx.body = { admindata, metadata };
  } else {
    await next();
  }
}

async function constructAndMaybeReturnReshareRequest(ctx, next) {
  const { admindata, co, svcCfg, symbol } = ctx.state;
  ctx.cfg.log('flow', 'Construct reshare request');
  const rr = new ReshareRequest(co);
  const rreq = rr.getRequest();
  rreq.requestingInstitutionSymbol = symbol.includes(':') ? symbol : `RESHARE:${symbol}`;

  if (svcCfg.digitalOnly) rreq.deliveryMethod = 'URL';

  ctx.cfg.log('rr', JSON.stringify(rreq));
  if (admindata.svc?.id === 'reshareRequest') {
    ctx.body = rreq;
  } else {
    ctx.state.rreq = rreq;
    await next();
  }
}

async function postReshareRequest(ctx, next) {
  const { admindata, metadata, npl, rreq, service } = ctx.state;

  ctx.cfg.log('flow', 'Post mod-rs request');
  // Provide a way to provoke a failure (for testing): include ctx_FAIL in the OpenURL
  const path = get(admindata, 'ctx.FAIL') ? '/not-there' : '/rs/patronrequests';
  const res = await service.post(path, rreq);
  const body = await res.text();
  ctx.cfg.log('posted', `sent request, status ${res.status}`);

  if (`${res.status}`[0] !== '2') {
    ctx.cfg.log('error', `POST error ${res.status}:`, body);
    ctx.throw(500, 'Error encountered submitting request to mod-rs', { expose: true });
  }

  if (admindata.svc?.id === 'json') {
    ctx.set('Content-Type', 'text/json');
    ctx.body = {
      status: res.status,
      message: body,
      contextObject: { admindata, metadata },
      reshareRequest: rreq,
    };
  } else {
    ctx.set('Content-Type', 'text/html');
    const status = `${res.status}`;
    const vars = { status };
    try {
      vars.json = JSON.parse(body);
    } catch (e) {
      vars.text = body;
    };

    if (!npl) {
      await service.getPickupLocations();
      const location = find(service.pickupLocations, x => x.code === vars.json.pickupLocationSlug);
      if (location) vars.pickupLocationName = location.name;
    }

    const ok = (status[0] === '2');
    const template = ctx.cfg.getTemplate(ok ? 'good' : 'bad');
    ctx.body = template(vars);
  }
};

class OpenURLServer {
  constructor(cfg) {
    this.services = {};

    const serviceConfigs = cfg.getValues().services || [];
    Object.keys(serviceConfigs).forEach(label => {
      this.services[label] = new OkapiSession(cfg, label, serviceConfigs[label]);
    });

    // Default service
    if (cfg.getValues().okapiUrl) this.services[''] = new OkapiSession(cfg);

    const docRoot = cfg.getValues().docRoot;
    if (!docRoot) {
      throw new Error('No docRoot defined in configuration');
    }
    const koaStatic = KoaStatic(`${cfg.path}/${docRoot}`);

    const app = new Koa();
    app.context.cfg = cfg;
    app.context.services = this.services;

    // koa-static doesn't call next() if it matches so we could almost have just used it except for
    // the fact we want to only conditionally return index.html at root
    //
    // We could almost use koa-router at the top level here but we have services combined with /static
    // and potentially other fixed endpoints so it'd need some awkward regexen.
    //
    // Instead, this top level middleware is essentially a router. koa-compose can bring together the
    // OpenURL pieces and we can potentially use koa-router for other parts if we end up adding
    // functionality
    app.use(async function(ctx, next) {
      if (ctx.path.startsWith('/static/') ||
          ctx.path === '/favicon.ico' ||
          (ctx.path === '/' && ctx.search === '')) {
        return koaStatic(ctx, next);
      }
      return compose([
        parseRequest,
        maybeRenderForm,
        maybeReturnAdminData,
        constructAndMaybeReturnReshareRequest,
        postReshareRequest,
      ])(ctx, next);
    });

    this.app = app;
  }

  initializeOkapiSessions() {
    return Promise.all(
      Object.keys(this.services).map(label => this.services[label].login())
    );
  }

  listen(...args) {
    return this.app.listen(...args);
  }
}

module.exports = { OpenURLServer };
