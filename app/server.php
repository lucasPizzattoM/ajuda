<?php
/*
 * Servidor da aula ao vivo.
 *
 * Entrega a página (public/index.html) e repassa, em tempo real, os desenhos e cliques
 * entre quem está na mesma sala. Fala HTTP e WebSocket na mesma porta.
 * Não precisa de nenhuma biblioteca: só PHP 8.1 ou mais novo (linha de comando).
 *
 *   php server.php            (porta 8080)
 *   PORTA=9000 php server.php
 */
declare(strict_types=1);

const GUID_WS        = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MENSAGEM   = 1048576;   // 1 MB por mensagem
const MAX_CABECALHO  = 16384;     // 16 KB de cabeçalho HTTP
const MAX_SAIDA      = 8388608;   // 8 MB esperando para sair (cliente muito lento é derrubado)
const MAX_CONEXOES   = 400;
const MAX_POR_SALA   = 30;
const LIMITE_MSGS    = 1500;      // mensagens por pessoa a cada JANELA segundos
const JANELA         = 10;
const PING_A_CADA    = 25;        // segundos
const TIMEOUT_WS     = 75;        // sem notícias por esse tempo, a conexão é fechada
const TIMEOUT_HTTP   = 15;

final class Servidor
{
    /** @var resource */
    private $servidor;
    /** @var array<int, array<string, mixed>> */
    private array $c = [];
    /** @var array<string, array<int, true>> */
    private array $salas = [];
    private float $ultimaManutencao = 0.0;

    public function __construct(private int $porta, private string $publico)
    {
    }

    public function rodar(): void
    {
        $ctx = stream_context_create(['socket' => ['backlog' => 128, 'tcp_nodelay' => true]]);
        $s = @stream_socket_server("tcp://0.0.0.0:{$this->porta}", $errno, $errstr,
            STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $ctx);
        if (!$s) {
            $this->log("Não consegui abrir a porta {$this->porta}: $errstr");
            exit(1);
        }
        stream_set_blocking($s, false);
        $this->servidor = $s;
        $this->log("Aula ao vivo rodando na porta {$this->porta}");
        while (true) {
            $this->volta();
        }
    }

    private function volta(): void
    {
        $ler = [$this->servidor];
        $escrever = [];
        foreach ($this->c as $cl) {
            $ler[] = $cl['sock'];
            if ($cl['out'] !== '') {
                $escrever[] = $cl['sock'];
            }
        }
        $exc = null;
        $n = @stream_select($ler, $escrever, $exc, 1, 0);
        if ($n === false) {
            usleep(20000);
        } else {
            foreach ($ler as $s) {
                if ($s === $this->servidor) {
                    $this->aceitar();
                    continue;
                }
                $k = get_resource_id($s);
                if (!isset($this->c[$k])) {
                    continue;
                }
                $dados = @fread($s, 65536);
                if ($dados === false || ($dados === '' && feof($s))) {
                    $this->desconectar($k);
                    continue;
                }
                if ($dados === '') {
                    continue;
                }
                $this->c[$k]['in'] .= $dados;
                $this->c[$k]['visto'] = microtime(true);
                if ($this->c[$k]['ws']) {
                    $this->lerFrames($k);
                } else {
                    $this->lerHttp($k);
                }
            }
            foreach ($escrever as $s) {
                $k = get_resource_id($s);
                if (isset($this->c[$k])) {
                    $this->escrever($k);
                }
            }
        }
        $agora = microtime(true);
        if ($agora - $this->ultimaManutencao >= 1.0) {
            $this->ultimaManutencao = $agora;
            $this->manutencao($agora);
        }
    }

    private function aceitar(): void
    {
        for ($i = 0; $i < 32; $i++) {
            $s = @stream_socket_accept($this->servidor, 0, $peer);
            if (!$s) {
                return;
            }
            if (count($this->c) >= MAX_CONEXOES) {
                @fclose($s);
                continue;
            }
            stream_set_blocking($s, false);
            $agora = microtime(true);
            $this->c[get_resource_id($s)] = [
                'sock' => $s, 'in' => '', 'out' => '', 'ws' => false, 'fechar' => false,
                'frag' => null, 'sala' => null, 'id' => null, 'nome' => '', 'papel' => 'aluno',
                'visto' => $agora, 'ping' => $agora, 'janela' => $agora, 'qtd' => 0,
            ];
        }
    }

    /* ------------------------------ HTTP ------------------------------ */

    private function lerHttp(int $k): void
    {
        $buf = $this->c[$k]['in'];
        $fim = strpos($buf, "\r\n\r\n");
        if ($fim === false) {
            if (strlen($buf) > MAX_CABECALHO) {
                $this->responderHttp($k, 431, 'text/plain; charset=utf-8', 'Cabeçalho grande demais');
            }
            return;
        }
        $this->c[$k]['in'] = (string) substr($buf, $fim + 4);
        $linhas = explode("\r\n", substr($buf, 0, $fim));
        $req = explode(' ', (string) array_shift($linhas));
        if (count($req) < 3) {
            $this->responderHttp($k, 400, 'text/plain; charset=utf-8', 'Pedido inválido');
            return;
        }
        [$metodo, $alvo] = $req;
        $h = [];
        foreach ($linhas as $l) {
            $p = strpos($l, ':');
            if ($p) {
                $h[strtolower(trim(substr($l, 0, $p)))] = trim(substr($l, $p + 1));
            }
        }
        $caminho = (string) (parse_url($alvo, PHP_URL_PATH) ?: '/');

        if ($caminho === '/ws') {
            $this->aceitarWs($k, $h);
            return;
        }
        if ($metodo !== 'GET' && $metodo !== 'HEAD') {
            $this->responderHttp($k, 405, 'text/plain; charset=utf-8', 'Método não permitido');
            return;
        }
        $soCabecalho = $metodo === 'HEAD';
        if ($caminho === '/' || $caminho === '/index.html') {
            $html = @file_get_contents($this->publico . '/index.html');
            if ($html === false) {
                $this->responderHttp($k, 500, 'text/plain; charset=utf-8', 'Página não encontrada no servidor');
            } else {
                $this->responderHttp($k, 200, 'text/html; charset=utf-8', $html, $soCabecalho);
            }
            return;
        }
        if ($caminho === '/saude') {
            $this->responderHttp($k, 200, 'text/plain; charset=utf-8', "ok\n", $soCabecalho);
            return;
        }
        $this->responderHttp($k, 404, 'text/plain; charset=utf-8', 'Não encontrado', $soCabecalho);
    }

    private function responderHttp(int $k, int $codigo, string $tipo, string $corpo, bool $soCabecalho = false): void
    {
        $textos = [200 => 'OK', 400 => 'Bad Request', 403 => 'Forbidden', 404 => 'Not Found',
            405 => 'Method Not Allowed', 431 => 'Request Header Fields Too Large', 500 => 'Internal Server Error'];
        $r = "HTTP/1.1 $codigo " . ($textos[$codigo] ?? 'OK') . "\r\n"
            . "Content-Type: $tipo\r\n"
            . 'Content-Length: ' . strlen($corpo) . "\r\n"
            . "Cache-Control: no-cache\r\n"
            . "X-Content-Type-Options: nosniff\r\n"
            . "Referrer-Policy: same-origin\r\n"
            . "Connection: close\r\n\r\n"
            . ($soCabecalho ? '' : $corpo);
        $this->c[$k]['fechar'] = true;
        $this->enfileirar($k, $r);
    }

    /** @param array<string, string> $h */
    private function aceitarWs(int $k, array $h): void
    {
        $chave = $h['sec-websocket-key'] ?? '';
        if (strtolower($h['upgrade'] ?? '') !== 'websocket' || $chave === ''
            || ($h['sec-websocket-version'] ?? '') !== '13') {
            $this->responderHttp($k, 400, 'text/plain; charset=utf-8', 'Esperava uma conexão WebSocket');
            return;
        }
        /* Só aceita conexões vindas da própria página (mesmo endereço). */
        $origem = $h['origin'] ?? '';
        if ($origem !== '') {
            $hostOrigem = strtolower((string) parse_url($origem, PHP_URL_HOST));
            $hostPedido = strtolower((string) preg_replace('/:\d+$/', '', $h['host'] ?? ''));
            if ($hostOrigem !== $hostPedido) {
                $this->responderHttp($k, 403, 'text/plain; charset=utf-8', 'Origem não permitida');
                return;
            }
        }
        $aceite = base64_encode(sha1($chave . GUID_WS, true));
        $this->enfileirar($k, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            . "Connection: Upgrade\r\nSec-WebSocket-Accept: $aceite\r\n\r\n");
        if (!isset($this->c[$k])) {
            return;
        }
        $this->c[$k]['ws'] = true;
        if ($this->c[$k]['in'] !== '') {
            $this->lerFrames($k);
        }
    }

    /* ---------------------------- WebSocket ---------------------------- */

    private function lerFrames(int $k): void
    {
        while (isset($this->c[$k]) && !$this->c[$k]['fechar']) {
            $b = $this->c[$k]['in'];
            $tam = strlen($b);
            if ($tam < 2) {
                return;
            }
            $b0 = ord($b[0]);
            $b1 = ord($b[1]);
            $fin = ($b0 & 0x80) !== 0;
            $op = $b0 & 0x0F;
            $pl = $b1 & 0x7F;
            $pos = 2;
            if (($b0 & 0x70) !== 0 || ($b1 & 0x80) === 0) {
                $this->fecharWs($k, 1002);   // bits reservados ou mensagem sem máscara
                return;
            }
            if ($pl === 126) {
                if ($tam < 4) {
                    return;
                }
                $pl = unpack('n', substr($b, 2, 2))[1];
                $pos = 4;
            } elseif ($pl === 127) {
                if ($tam < 10) {
                    return;
                }
                $pl = unpack('J', substr($b, 2, 8))[1];
                $pos = 10;
            }
            if ($pl < 0 || $pl > MAX_MENSAGEM) {
                $this->fecharWs($k, 1009);
                return;
            }
            if ($tam < $pos + 4 + $pl) {
                return;
            }
            $mascara = substr($b, $pos, 4);
            $dados = (string) substr($b, $pos + 4, $pl);
            $this->c[$k]['in'] = (string) substr($b, $pos + 4 + $pl);
            if ($pl > 0) {
                $dados ^= substr(str_repeat($mascara, intdiv($pl, 4) + 1), 0, $pl);
            }

            switch ($op) {
                case 0x8: // fechar
                    $this->sairDaSala($k);
                    $this->fecharWs($k, strlen($dados) >= 2 ? unpack('n', substr($dados, 0, 2))[1] : 1000);
                    return;
                case 0x9: // ping
                    $this->enfileirar($k, $this->frame($dados, 0xA));
                    break;
                case 0xA: // pong
                    break;
                case 0x1: // texto
                    if ($this->c[$k]['frag'] !== null) {
                        $this->fecharWs($k, 1002);
                        return;
                    }
                    if ($fin) {
                        $this->texto($k, $dados);
                    } else {
                        $this->c[$k]['frag'] = $dados;
                    }
                    break;
                case 0x0: // continuação
                    if ($this->c[$k]['frag'] === null) {
                        $this->fecharWs($k, 1002);
                        return;
                    }
                    $this->c[$k]['frag'] .= $dados;
                    if (strlen($this->c[$k]['frag']) > MAX_MENSAGEM) {
                        $this->fecharWs($k, 1009);
                        return;
                    }
                    if ($fin) {
                        $txt = $this->c[$k]['frag'];
                        $this->c[$k]['frag'] = null;
                        $this->texto($k, $txt);
                    }
                    break;
                default: // binário e outros: não usamos
                    $this->fecharWs($k, 1003);
                    return;
            }
        }
    }

    private function frame(string $dados, int $op = 0x1): string
    {
        $n = strlen($dados);
        $cab = chr(0x80 | $op);
        if ($n < 126) {
            $cab .= chr($n);
        } elseif ($n < 65536) {
            $cab .= chr(126) . pack('n', $n);
        } else {
            $cab .= chr(127) . pack('J', $n);
        }
        return $cab . $dados;
    }

    private function fecharWs(int $k, int $codigo): void
    {
        if (!isset($this->c[$k])) {
            return;
        }
        $this->enfileirar($k, $this->frame(pack('n', $codigo), 0x8));
        if (isset($this->c[$k])) {
            $this->c[$k]['fechar'] = true;
            if ($this->c[$k]['out'] === '') {
                $this->desconectar($k);
            }
        }
    }

    /* ------------------------------ salas ------------------------------ */

    private function texto(int $k, string $txt): void
    {
        $d = json_decode($txt, false, 64);
        if (!($d instanceof stdClass) || !isset($d->tipo) || !is_string($d->tipo)) {
            return;
        }
        switch ($d->tipo) {
            case 'pulso':
                $this->enviarJson($k, ['tipo' => 'pulso']);
                return;
            case 'entrar':
                $this->entrar($k, $d);
                return;
            case 'msg':
                $sala = $this->c[$k]['sala'];
                if ($sala === null || !isset($d->m) || !($d->m instanceof stdClass) || !$this->dentroDoLimite($k)) {
                    return;
                }
                $json = json_encode(['tipo' => 'msg', 'm' => $d->m], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if ($json !== false) {
                    $this->paraSala($sala, $json, $k);
                }
                return;
        }
    }

    private function entrar(int $k, stdClass $d): void
    {
        $sala = is_string($d->sala ?? null) ? $d->sala : '';
        $id = is_string($d->id ?? null) ? $d->id : '';
        if (!preg_match('/^[A-Z0-9]{5}$/', $sala) || !preg_match('/^[a-z0-9]{6,16}$/', $id)) {
            $this->enviarJson($k, ['tipo' => 'erro', 'texto' => 'Código de aula inválido.']);
            return;
        }
        if ($this->c[$k]['sala'] !== null) {
            $this->sairDaSala($k);
        }
        /* A mesma pessoa reconectando: a conexão antiga sai. */
        foreach (array_keys($this->salas[$sala] ?? []) as $outro) {
            if ($outro !== $k && isset($this->c[$outro]) && $this->c[$outro]['id'] === $id) {
                $this->desconectar($outro);
            }
        }
        if (count($this->salas[$sala] ?? []) >= MAX_POR_SALA) {
            $this->enviarJson($k, ['tipo' => 'erro', 'texto' => 'Essa aula já está cheia.']);
            return;
        }
        $this->c[$k]['sala'] = $sala;
        $this->c[$k]['id'] = $id;
        $this->c[$k]['nome'] = $this->limparNome($d->nome ?? '');
        $this->c[$k]['papel'] = (($d->papel ?? '') === 'professor') ? 'professor' : 'aluno';
        $this->salas[$sala][$k] = true;
        $this->log("{$this->c[$k]['nome']} entrou na sala $sala ({$this->c[$k]['papel']}), "
            . count($this->salas[$sala]) . ' na sala');
        $this->avisarPessoas($sala);
    }

    private function sairDaSala(int $k): void
    {
        $sala = $this->c[$k]['sala'] ?? null;
        if ($sala === null) {
            return;
        }
        $this->c[$k]['sala'] = null;
        unset($this->salas[$sala][$k]);
        $this->log("{$this->c[$k]['nome']} saiu da sala $sala");
        if (empty($this->salas[$sala])) {
            unset($this->salas[$sala]);
        } else {
            $this->avisarPessoas($sala);
        }
    }

    private function avisarPessoas(string $sala): void
    {
        $lista = [];
        foreach (array_keys($this->salas[$sala] ?? []) as $k) {
            if (isset($this->c[$k])) {
                $lista[] = ['id' => $this->c[$k]['id'], 'nome' => $this->c[$k]['nome'], 'papel' => $this->c[$k]['papel']];
            }
        }
        $json = json_encode(['tipo' => 'pessoas', 'lista' => $lista], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            $this->paraSala($sala, $json, null);
        }
    }

    private function paraSala(string $sala, string $json, ?int $exceto): void
    {
        $f = $this->frame($json);
        foreach (array_keys($this->salas[$sala] ?? []) as $k) {
            if ($k !== $exceto) {
                $this->enfileirar($k, $f);
            }
        }
    }

    /** @param array<string, mixed> $dados */
    private function enviarJson(int $k, array $dados): void
    {
        $json = json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            $this->enfileirar($k, $this->frame($json));
        }
    }

    private function dentroDoLimite(int $k): bool
    {
        $agora = microtime(true);
        if ($agora - $this->c[$k]['janela'] > JANELA) {
            $this->c[$k]['janela'] = $agora;
            $this->c[$k]['qtd'] = 0;
        }
        return ++$this->c[$k]['qtd'] <= LIMITE_MSGS;
    }

    private function limparNome(mixed $nome): string
    {
        $nome = is_string($nome) ? $nome : '';
        $nome = trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', $nome));
        $nome = trim(function_exists('mb_substr') ? mb_substr($nome, 0, 20) : substr($nome, 0, 20));
        return $nome !== '' ? $nome : 'Visitante';
    }

    /* ----------------------------- conexões ----------------------------- */

    private function enfileirar(int $k, string $bytes): void
    {
        if (!isset($this->c[$k])) {
            return;
        }
        $this->c[$k]['out'] .= $bytes;
        if (strlen($this->c[$k]['out']) > MAX_SAIDA) {
            $this->desconectar($k);
            return;
        }
        $this->escrever($k);
    }

    private function escrever(int $k): void
    {
        $out = $this->c[$k]['out'];
        if ($out !== '') {
            $n = @fwrite($this->c[$k]['sock'], $out);
            if ($n === false) {
                $this->desconectar($k);
                return;
            }
            $this->c[$k]['out'] = (string) substr($out, $n);
        }
        if ($this->c[$k]['out'] === '' && $this->c[$k]['fechar']) {
            $this->desconectar($k);
        }
    }

    private function desconectar(int $k): void
    {
        if (!isset($this->c[$k])) {
            return;
        }
        $s = $this->c[$k]['sock'];
        $this->sairDaSala($k);
        unset($this->c[$k]);
        @fclose($s);
    }

    private function manutencao(float $agora): void
    {
        foreach (array_keys($this->c) as $k) {
            if (!isset($this->c[$k])) {
                continue;
            }
            $cl = $this->c[$k];
            $limite = $cl['ws'] ? TIMEOUT_WS : TIMEOUT_HTTP;
            if ($agora - $cl['visto'] > $limite) {
                $this->desconectar($k);
                continue;
            }
            if ($cl['ws'] && !$cl['fechar'] && $agora - $cl['ping'] > PING_A_CADA) {
                $this->c[$k]['ping'] = $agora;
                $this->enfileirar($k, $this->frame('', 0x9));
            }
        }
    }

    private function log(string $msg): void
    {
        fwrite(STDOUT, date('Y-m-d H:i:s') . ' ' . $msg . "\n");
    }
}

date_default_timezone_set(getenv('TZ') ?: 'America/Sao_Paulo');
(new Servidor((int) (getenv('PORTA') ?: 8080), __DIR__ . '/public'))->rodar();
