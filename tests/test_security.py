import unittest

from src.security import EndpointValidationError, validate_rpc_endpoint


class RpcEndpointValidationTests(unittest.TestCase):
    def test_public_https_endpoint_is_allowed(self):
        self.assertEqual(
            validate_rpc_endpoint("SOLANA_RPC", "https://api.mainnet-beta.solana.com"),
            "https://api.mainnet-beta.solana.com",
        )

    def test_non_https_endpoint_is_rejected(self):
        with self.assertRaises(EndpointValidationError):
            validate_rpc_endpoint("SOLANA_RPC", "http://api.example.test")

    def test_localhost_and_private_ip_are_rejected(self):
        for value in ("https://localhost:8899", "https://127.0.0.1:8899", "https://192.168.1.10"):
            with self.subTest(value=value):
                with self.assertRaises(EndpointValidationError):
                    validate_rpc_endpoint("SOLANA_RPC", value)

    def test_credentials_in_url_are_rejected(self):
        with self.assertRaises(EndpointValidationError):
            validate_rpc_endpoint("SOLANA_RPC", "https://token@example.test")


if __name__ == "__main__":
    unittest.main()
