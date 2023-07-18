//SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";

contract TestVault is ERC4626 {
  using SafeERC20 for IERC20Metadata;

  uint256 internal _debt;

  constructor(
    string memory name_,
    string memory symbol_,
    IERC20Metadata asset_
  ) ERC20(name_, symbol_) ERC4626(asset_) {}

  /** @dev See {IERC4262-totalAssets}. */
  function totalAssets() public view virtual override returns (uint256) {
    return _balance() + _debt;
  }

  function _asset() internal view returns (IERC20Metadata) {
    return IERC20Metadata(asset());
  }

  function _balance() internal view returns (uint256) {
    return _asset().balanceOf(address(this));
  }

  /**
   * @dev Withdraw/redeem common workflow.
   */
  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    require(_balance() >= assets, "ERC4626CashFlowLender: Not enough balance to withdraw");
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /** @dev See {IERC4626-maxWithdraw}. */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    return Math.min(super.maxWithdraw(owner), _balance());
  }

  /** @dev See {IERC4626-maxRedeem}. */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    return Math.min(super.maxRedeem(owner), _convertToShares(_balance(), Math.Rounding.Down));
  }

  /**
   * Two functions to simulate an iliquid vault that gives loans (without collateral, it's a mock Contract)
   * and receives the repayment with interest, increasing the assets (and not the shares).
   */
  function lend(address borrower, uint256 amount) external {
    _debt += amount;
    _asset().safeTransfer(borrower, amount);
  }

  function repay(
    address borrower,
    uint256 amount,
    uint256 interest
  ) external {
    _debt -= amount;
    _asset().safeTransferFrom(borrower, address(this), amount + interest);
  }

  function debtDefault(uint256 amount) external {
    _debt -= amount;
  }
}
