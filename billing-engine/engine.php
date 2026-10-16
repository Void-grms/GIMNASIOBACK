<?php
declare(strict_types=1);
// Entrada privada por stdin. No servidor HTTP, SOAP, rutas ni comandos del usuario.
require __DIR__.'/vendor/autoload.php';
use Greenter\Model\Company\{Company, Address};
use Greenter\Model\Client\Client;
use Greenter\Model\Sale\{Invoice, SaleDetail, Legend};
use Greenter\Model\Sale\FormaPagos\FormaPagoContado;
use Greenter\Xml\Builder\InvoiceBuilder;
use Greenter\XMLSecLibs\Sunat\SignedXml;
use Greenter\XMLSecLibs\{XMLSecurityDSig, XMLSecurityKey};

ini_set('display_errors','0');
set_error_handler(function(int $severity,string $message) { if ((error_reporting() & $severity) && !in_array($severity,[E_DEPRECATED,E_USER_DEPRECATED],true)) throw new RuntimeException('Error de motor'); return true; });
function certificado(array $input): array {
    $demo = empty($input['certificadoPfxBase64']);
    if (!$demo) {
        $raw=base64_decode($input['certificadoPfxBase64'],true);
        if ($raw===false || strlen($raw)>1000000 || !openssl_pkcs12_read($raw,$certs,(string)($input['certificadoPassword']??''))) throw new RuntimeException('Certificado no valido');
    } else {
        $key=openssl_pkey_new(['private_key_bits'=>2048,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);
        $csr=openssl_csr_new(['commonName'=>'FORCES GYM PRUEBA SIN VALIDEZ TRIBUTARIA','countryName'=>'PE'],$key,['digest_alg'=>'sha256']);
        $cert=openssl_csr_sign($csr,null,$key,365,['digest_alg'=>'sha256'],random_int(1,PHP_INT_MAX));
        openssl_x509_export($cert,$pub);openssl_pkey_export($key,$priv);$certs=['cert'=>$pub,'pkey'=>$priv];
    }
    if (!openssl_x509_check_private_key($certs['cert'],$certs['pkey'])) throw new RuntimeException('Clave no correspondiente');
    $data=openssl_x509_parse($certs['cert']);
    if (!$data || $data['validFrom_time_t']>time() || $data['validTo_time_t']<=time()) throw new RuntimeException('Certificado fuera de vigencia');
    return [$certs['cert']."\n".$certs['pkey'], ['subject'=>substr((string)($data['subject']['CN']??'Certificado digital'),0,200),'validFrom'=>gmdate('c',$data['validFrom_time_t']),'validTo'=>gmdate('c',$data['validTo_time_t']),'esPrueba'=>$demo]];
}
try {
    $raw=stream_get_contents(STDIN,2000001);if(strlen($raw)>2000000)throw new RuntimeException('Limite de entrada');
    $input=json_decode($raw,true,32,JSON_THROW_ON_ERROR);
    if (!in_array($input['action']??'', ['generate','inspectCertificate'],true)) throw new RuntimeException('Accion no admitida');
    [$pem,$metadata]=certificado($input);
    if ($input['action']==='inspectCertificate') { echo json_encode(['certificado'=>$metadata],JSON_THROW_ON_ERROR); exit; }
    $d=$input['documento'];
    if (!preg_match('/^\d{11}$/D',$d['ruc']) || !in_array($d['tipo'],['01','03'],true) || !preg_match('/^[BF][A-Z0-9]{3}$/D',$d['serie']) || !is_int($d['numero']) || $d['numero']<1 || $d['numero']>99999999) throw new RuntimeException('Documento no admitido');
    if(count($d['items'])!==1)throw new RuntimeException('Solo ensayo de una linea');
    $item=$d['items'][0];$gross=$item['precioUnitarioCentimos'];
    if($gross!==6000||($item['cantidad']??1)!==1||$item['afectacion']!=='10')throw new RuntimeException('Perfil de ensayo no admitido');
    $net=intdiv($gross*100+59,118);$tax=$gross-$net;
    $address=(new Address())->setUbigueo($d['ubigeo'])->setDepartamento($d['departamento'])->setProvincia($d['provincia'])->setDistrito($d['distrito'])->setDireccion($d['direccion'])->setCodigoPais('PE');
    $company=(new Company())->setRuc($d['ruc'])->setRazonSocial($d['razonSocial'])->setNombreComercial($d['nombreComercial']??'PRUEBA')->setAddress($address);
    $client=(new Client())->setTipoDoc($d['tipo']==='01'?'6':'1')->setNumDoc($d['tipo']==='01'?'20999999994':'00000000')->setRznSocial('CLIENTE FICTICIO - PRUEBA SIN VALIDEZ TRIBUTARIA');
    $detail=(new SaleDetail())->setCodProducto('PRUEBA')->setUnidad('ZZ')->setCantidad(1)->setDescripcion($item['descripcion'])->setMtoBaseIgv($net/100)->setPorcentajeIgv(18)->setIgv($tax/100)->setTipAfeIgv('10')->setTotalImpuestos($tax/100)->setMtoValorVenta($net/100)->setMtoValorUnitario($net/100)->setMtoPrecioUnitario($gross/100);
    $invoice=(new Invoice())->setUblVersion('2.1')->setTipoDoc($d['tipo'])->setSerie($d['serie'])->setCorrelativo((string)$d['numero'])->setTipoOperacion('0101')->setFormaPago(new FormaPagoContado())->setFechaEmision(new DateTime($d['fecha'].'T12:00:00-05:00'))->setTipoMoneda('PEN')->setCompany($company)->setClient($client)->setMtoOperGravadas($net/100)->setMtoIGV($tax/100)->setTotalImpuestos($tax/100)->setValorVenta($net/100)->setSubTotal($gross/100)->setMtoImpVenta($gross/100)->setDetails([$detail])->setLegends([(new Legend())->setCode('1000')->setValue('SON SESENTA CON 00/100 SOLES - PRUEBA SIN VALIDEZ TRIBUTARIA')]);
    $unsigned=(new InvoiceBuilder())->build($invoice);
    $signer=new SignedXml();$signer->setCertificate($pem);$signer->setSignatureAlgorithm(XMLSecurityKey::RSA_SHA256);$signer->setDigestAlgorithm(XMLSecurityDSig::SHA256);
    $xml=$signer->signXml($unsigned);if(!$signer->verifyXml($xml))throw new RuntimeException('Firma no verificada');
    $dom=new DOMDocument();$dom->loadXML($xml,LIBXML_NONET);$xpath=new DOMXPath($dom);$xpath->registerNamespace('ds','http://www.w3.org/2000/09/xmldsig#');
    echo json_encode(['xmlBase64'=>base64_encode($xml),'nombreArchivo'=>$d['ruc'].'-'.$d['tipo'].'-'.$d['serie'].'-'.$d['numero'],'hash'=>$xpath->evaluate('string(//ds:DigestValue)'),'certificado'=>$metadata,'firmaVerificada'=>true],JSON_THROW_ON_ERROR);
} catch(Throwable $e) { if(getenv('SUNAT_ENGINE_DEBUG')==='1')fwrite(STDERR,get_class($e).':'.basename($e->getFile()).':'.$e->getLine()); fwrite(STDOUT,json_encode(['error'=>'No se pudo validar o firmar el documento de prueba'])); exit(1); }
