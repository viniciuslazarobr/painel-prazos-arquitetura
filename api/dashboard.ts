import type { IncomingMessage, ServerResponse } from 'http';
import { supabase, calculateDaysRemaining, formatDateBR, getTodayDateString, createProcess, completeProcess } from '../src/supabase';
import { bot } from '../src/bot';

// Helper para ler body JSON
async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Configuração de Autenticação para Acesso ao Painel
const DEFAULT_PASSWORD = process.env.DASHBOARD_PASSWORD || 'prazos2026';
const TOKEN_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || 'prazos-secret-key-2026';
const VALID_USERS: Record<string, string> = {
  [process.env.DASHBOARD_USER?.toLowerCase() || 'admin']: DEFAULT_PASSWORD,
  'escritorio': DEFAULT_PASSWORD,
  'alexandre': DEFAULT_PASSWORD,
  'anderson': DEFAULT_PASSWORD,
  'dinho': DEFAULT_PASSWORD,
};

async function getUserPassword(username: string): Promise<string> {
  const normalizedUser = username.trim().toLowerCase();
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', `user_pass_${normalizedUser}`)
      .maybeSingle();

    if (data && data.value) {
      return data.value;
    }
  } catch (err) {
    console.warn('[Auth] Erro ao buscar senha customizada no banco:', err);
  }

  // Fallback para usuário configurado ou senha padrão
  return VALID_USERS[normalizedUser] || DEFAULT_PASSWORD;
}

async function setUserPassword(username: string, newPass: string): Promise<boolean> {
  const normalizedUser = username.trim().toLowerCase();
  try {
    const { error } = await supabase
      .from('app_settings')
      .upsert({
        key: `user_pass_${normalizedUser}`,
        value: newPass
      });

    return !error;
  } catch (err) {
    console.error('[Auth] Erro ao salvar senha:', err);
    return false;
  }
}

function generateToken(username: string): string {
  const ts = Date.now();
  const sig = Buffer.from(`${username}:${ts}:${TOKEN_SECRET}`).toString('base64');
  return Buffer.from(JSON.stringify({ u: username, t: ts, sig })).toString('base64');
}

function validateAuth(req: IncomingMessage): { valid: boolean; user?: string } {
  const authHeader = req.headers['authorization'] || req.headers['x-dashboard-auth'];
  if (!authHeader) return { valid: false };

  const tokenStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = tokenStr.replace(/^Bearer\s+/i, '').trim();

  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const parsed = JSON.parse(raw);
    const expectedSig = Buffer.from(`${parsed.u}:${parsed.t}:${TOKEN_SECRET}`).toString('base64');
    if (parsed.sig === expectedSig) {
      return { valid: true, user: parsed.u };
    }
  } catch (e) {
    // Falha na validação do token
  }
  return { valid: false };
}

// Consulta em tempo real aos despachos e matérias no DOSP (Diário Oficial da Cidade de SP)
async function fetchDospPublications(processNumber: string) {
  try {
    const payload = new URLSearchParams({
      hdnTermoPesquisa: processNumber.trim(),
      hdnTipoPesquisa: 'E',
      hdnVersaoDiario: 'A',
      hdnOndePesquisa: 'C',
      hdnTipoDataPesquisa: 'I',
      hdnDataInicioPesquisa: '',
      hdnDataFimPesquisa: '',
      hdnTipoDocumentoPesquisa: '',
      hdnVeiculoPublicacao: '',
      hdnDataPublicacao: '',
      hdnOrgaoFiltro: '',
      hdnUnidadeResponsavelFiltro: '',
      hdnTipoDocumentoFiltro: '',
      hdnInicio: '0',
      hdnVisualizacao: 'L',
      hdnModoPesquisa: 'RAPIDA'
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch('https://diariooficial.prefeitura.sp.gov.br/md_epubli_controlador.php?acao=materias_pesquisar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: payload.toString(),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`DOSP retornou status HTTP ${res.status}`);
    }

    const html = await res.text();
    const publications: Array<{
      orgao: string;
      processo: string;
      documento: string;
      dataPublicacao: string;
      secao: string;
      trecho: string;
    }> = [];

    // Busca blocos de matérias e despachos na resposta
    const docMatch = html.match(/Documento:\s*(\d+)\s*-\s*([^<\n\r]+)/i);
    const orgaoMatch = html.match(/([A-Z0-9_-]+\s*>\s*[A-Z0-9_/-]+)/i);
    const dateMatch = html.match(/Publicado em\s*(\d{2}\/\d{2}\/\d{4})/i);
    const cleanText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    const hasOccurrence = cleanText.includes(processNumber.trim()) || docMatch !== null;

    if (hasOccurrence) {
      publications.push({
        orgao: orgaoMatch ? orgaoMatch[1].trim() : 'Prefeitura de São Paulo / Subprefeitura',
        processo: processNumber,
        documento: docMatch ? `${docMatch[1]} - ${docMatch[2].trim()}` : 'Despacho publicado',
        dataPublicacao: dateMatch ? dateMatch[1] : 'Publicação no Diário',
        secao: 'Atos do Executivo',
        trecho: `Despacho referente ao processo ${processNumber} localizado no Diário Oficial.`
      });
    }

    return {
      ok: true,
      found: publications.length > 0,
      publications,
      total: publications.length
    };
  } catch (err: any) {
    console.error('[DOSP Lookup Error]', err);
    return {
      ok: false,
      found: false,
      error: err?.message || 'Falha ao consultar o Diário Oficial no momento.',
      publications: []
    };
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // CORS headers para permitir consumo seguro
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-dashboard-auth');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);

  try {
    // 1. GET: Retorna dados completos para o Dashboard (Requer Autenticação)
    if (req.method === 'GET') {
      const auth = validateAuth(req);
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Não autorizado. Faça login para continuar.' }));
        return;
      }

      const [{ data: allProcesses, error: pErr }, { data: members, error: mErr }] = await Promise.all([
        supabase.from('processes').select('*').order('due_date', { ascending: true }),
        supabase.from('team_members').select('*').order('name', { ascending: true })
      ]);

      if (pErr) throw new Error(pErr.message);

      const processes = (allProcesses || []).map(proc => {
        const daysRemaining = calculateDaysRemaining(proc.due_date);
        let urgency: 'atrasado' | 'hoje' | 'amanha' | 'semana' | 'futuro' | 'concluido' = 'futuro';

        if (proc.status === 'CONCLUIDO') {
          urgency = 'concluido';
        } else if (daysRemaining < 0) {
          urgency = 'atrasado';
        } else if (daysRemaining === 0) {
          urgency = 'hoje';
        } else if (daysRemaining === 1) {
          urgency = 'amanha';
        } else if (daysRemaining <= 7) {
          urgency = 'semana';
        }

        return {
          ...proc,
          daysRemaining,
          urgency,
          dueDateFormatted: formatDateBR(proc.due_date),
          createdDateFormatted: proc.created_at ? new Date(proc.created_at).toLocaleDateString('pt-BR') : '',
          completedDateFormatted: proc.completed_at ? new Date(proc.completed_at).toLocaleDateString('pt-BR') : null,
        };
      });

      // Cálculos de métricas (KPIs)
      const pendingList = processes.filter(p => p.status === 'PENDENTE');
      const overdueList = pendingList.filter(p => p.daysRemaining < 0);
      const todayList = pendingList.filter(p => p.daysRemaining === 0);
      const next7DaysList = pendingList.filter(p => p.daysRemaining > 0 && p.daysRemaining <= 7);
      const completedList = processes.filter(p => p.status === 'CONCLUIDO');

      // Agrupamento por responsável
      const memberStats: Record<string, { total: number; pending: number; overdue: number; today: number; completed: number }> = {};
      
      (members || []).forEach(m => {
        memberStats[m.name] = { total: 0, pending: 0, overdue: 0, today: 0, completed: 0 };
      });

      processes.forEach(p => {
        const owner = p.owner_name || 'Sem Responsável';
        if (!memberStats[owner]) {
          memberStats[owner] = { total: 0, pending: 0, overdue: 0, today: 0, completed: 0 };
        }
        memberStats[owner].total++;
        if (p.status === 'CONCLUIDO') {
          memberStats[owner].completed++;
        } else {
          memberStats[owner].pending++;
          if (p.daysRemaining < 0) memberStats[owner].overdue++;
          if (p.daysRemaining === 0) memberStats[owner].today++;
        }
      });

      // Coleta todos os membros da tabela e mescla com responsáveis dos processos (ex: ANDERSON)
      const memberNamesSet = new Set<string>();
      const combinedMembers: Array<{ telegram_user_id: string; name: string }> = [];

      (members || []).forEach(m => {
        if (m.name) {
          memberNamesSet.add(m.name.trim().toLowerCase());
          combinedMembers.push({ telegram_user_id: m.telegram_user_id, name: m.name.trim() });
        }
      });

      // Se Anderson ou outro membro tiver processos mas ainda não estiver em team_members, inclui na lista
      processes.forEach(p => {
        const owner = p.owner_name?.trim();
        if (owner && !memberNamesSet.has(owner.toLowerCase())) {
          memberNamesSet.add(owner.toLowerCase());
          combinedMembers.push({
            telegram_user_id: p.owner_telegram_id || `unassigned_${owner.toLowerCase().replace(/\s+/g, '_')}`,
            name: owner,
          });
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        metrics: {
          total: processes.length,
          pending: pendingList.length,
          overdue: overdueList.length,
          today: todayList.length,
          next7Days: next7DaysList.length,
          completed: completedList.length,
        },
        memberStats,
        teamMembers: combinedMembers.sort((a, b) => a.name.localeCompare(b.name)),
        processes,
        todaySaoPaulo: getTodayDateString(),
      }));
      return;
    }

    // 2. POST: Ações públicas (login) e protegidas (concluir, criar, editar, consulta DOSP)
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = body.action;

      // Ação Pública: Login no Painel
      if (action === 'login') {
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '').trim();

        const expectedPass = await getUserPassword(username);
        if (expectedPass && expectedPass === password) {
          const token = generateToken(username);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token, username }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Usuário ou senha incorretos.' }));
        return;
      }

      // Validação de autenticação para as demais ações
      const auth = validateAuth(req);
      if (!auth.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Não autorizado. Faça login para continuar.' }));
        return;
      }

      // Ação: Alterar Senha de Acesso
      if (action === 'change_password') {
        const currentPass = String(body.currentPassword || '').trim();
        const newPass = String(body.newPassword || '').trim();
        const targetUser = String(auth.user || body.username || '').trim().toLowerCase();

        if (!newPass || newPass.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'A nova senha deve ter pelo menos 4 caracteres.' }));
          return;
        }

        const validPass = await getUserPassword(targetUser);
        if (validPass !== currentPass) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Senha atual incorreta.' }));
          return;
        }

        const saved = await setUserPassword(targetUser, newPass);
        if (!saved) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Falha ao salvar a nova senha no banco de dados.' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Senha alterada com sucesso!' }));
        return;
      }

      // Ação: Consulta Diário Oficial SP (DOSP / ARQUIP)
      if (action === 'dosp_lookup') {
        const processNumber = String(body.processNumber || '');
        if (!processNumber) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'processNumber é obrigatório' }));
          return;
        }

        const dospData = await fetchDospPublications(processNumber);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dospData));
        return;
      }

      // Ação: Concluir Prazo
      if (action === 'complete') {
        const processId = Number(body.processId);
        const completedBy = String(body.completedBy || 'Dashboard Web');

        if (!processId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'processId é obrigatório' }));
          return;
        }

        const updated = await completeProcess(processId, completedBy);

        if (!updated) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Processo não encontrado.' }));
          return;
        }

        // Notifica no grupo do escritório se configurado
        try {
          const { data: setting } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'office_group_chat_id')
            .maybeSingle();

          if (bot && bot.api && setting?.value) {
            await bot.api.sendMessage(
              setting.value,
              `✅ *Prazo Concluído pelo Dashboard Web*\n\n` +
              `📁 *Processo:* \`${updated.process_number}\`\n` +
              `👤 *Cliente:* ${updated.client_name}\n` +
              `📝 *Prazo:* ${updated.deadline_info}\n` +
              `📐 *Responsável:* ${updated.owner_name}\n` +
              `✨ *Concluído por:* ${completedBy}`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (botErr) {
          console.warn('[Dashboard Web] Aviso: Notificação no Telegram falhou:', botErr);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, process: updated }));
        return;
      }

      // Ação: Criar Novo Prazo pelo Dashboard
      if (action === 'create') {
        const { process_number, client_name, deadline_info, owner_name, owner_telegram_id, due_date, remind_days_before } = body;

        if (!process_number || !client_name || !deadline_info || !due_date || !owner_name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Campos obrigatórios ausentes.' }));
          return;
        }

        const newProc = await createProcess({
          process_number,
          client_name,
          deadline_info,
          owner_name,
          owner_telegram_id: owner_telegram_id || `web_${Date.now()}`,
          due_date,
          remind_days_before: Number(remind_days_before) || 3,
        });

        // Notifica no grupo do escritório
        try {
          const { data: setting } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'office_group_chat_id')
            .maybeSingle();

          if (bot && bot.api && setting?.value) {
            await bot.api.sendMessage(
              setting.value,
              `📌 *Novo Prazo Cadastrado via Dashboard Web*\n\n` +
              `📁 *Processo:* \`${newProc.process_number}\`\n` +
              `👤 *Cliente:* ${newProc.client_name}\n` +
              `📝 *Prazo:* ${newProc.deadline_info}\n` +
              `📅 *Vencimento:* ${formatDateBR(newProc.due_date)}\n` +
              `📐 *Responsável:* ${newProc.owner_name}`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (botErr) {
          console.warn('[Dashboard Web] Aviso: Notificação de criação falhou:', botErr);
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, process: newProc }));
        return;
      }

      // Ação: Editar / Prorrogar Prazo
      if (action === 'update') {
        const { id, process_number, client_name, deadline_info, owner_name, owner_telegram_id, due_date, remind_days_before } = body;
        const processId = Number(id);

        if (!processId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'ID do processo é obrigatório' }));
          return;
        }

        const updateData: any = {};
        if (process_number) updateData.process_number = process_number.trim();
        if (client_name) updateData.client_name = client_name.trim();
        if (deadline_info) updateData.deadline_info = deadline_info.trim();
        if (owner_name) updateData.owner_name = owner_name.trim();
        if (owner_telegram_id) updateData.owner_telegram_id = String(owner_telegram_id);
        if (due_date) updateData.due_date = due_date;
        if (remind_days_before !== undefined) updateData.remind_days_before = Number(remind_days_before);

        const { data: updated, error: uErr } = await supabase
          .from('processes')
          .update(updateData)
          .eq('id', processId)
          .select()
          .single();

        if (uErr || !updated) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: uErr?.message || 'Falha ao atualizar processo' }));
          return;
        }

        // Notifica no Telegram se a data foi prorrogada ou alterada
        try {
          const { data: setting } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'office_group_chat_id')
            .maybeSingle();

          if (bot && bot.api && setting?.value) {
            await bot.api.sendMessage(
              setting.value,
              `✏️ *Prazo Atualizado pelo Painel Web*\n\n` +
              `📁 *Processo:* \`${updated.process_number}\`\n` +
              `👤 *Cliente:* ${updated.client_name}\n` +
              `📝 *Prazo:* ${updated.deadline_info}\n` +
              `📅 *Novo Vencimento:* ${formatDateBR(updated.due_date)}\n` +
              `📐 *Responsável:* ${updated.owner_name}`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (botErr) {
          console.warn('[Dashboard Web] Aviso: Notificação de edição falhou:', botErr);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, process: updated }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Ação não suportada.' }));
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Método não permitido.' }));
  } catch (err: any) {
    console.error('[Dashboard API Error]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
}
