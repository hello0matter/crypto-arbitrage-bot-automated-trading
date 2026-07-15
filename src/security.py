"""Dependency-free runtime guardrails for externally configured RPC URLs."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse


class EndpointValidationError(ValueError):
    """Raised when a configured RPC endpoint is unsafe or malformed."""


def validate_rpc_endpoint(name: str, value: str) -> str:
    """Accept public HTTPS RPC endpoints and reject ambiguous or local targets."""

    if not isinstance(value, str) or not value.strip():
        raise EndpointValidationError(f"{name} must be a non-empty HTTPS URL")

    normalized = value.strip()
    parsed = urlparse(normalized)
    if parsed.scheme.lower() != "https":
        raise EndpointValidationError(f"{name} must use HTTPS")
    if not parsed.hostname:
        raise EndpointValidationError(f"{name} must include a hostname")
    if parsed.username or parsed.password:
        raise EndpointValidationError(f"{name} must not embed credentials")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise EndpointValidationError(f"{name} must not target localhost")

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return normalized

    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    ):
        raise EndpointValidationError(f"{name} must not target a local or reserved IP address")
    return normalized


def validate_rpc_endpoints(solana_rpc: str, ton_rpc: str) -> None:
    """Validate all RPC settings before the trading components are initialized."""

    validate_rpc_endpoint("SOLANA_RPC", solana_rpc)
    validate_rpc_endpoint("TON_RPC", ton_rpc)
